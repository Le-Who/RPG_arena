import { smokeOwnerId, cleanupSmokeIdentity } from "./smoke-identity";
/** Run only against an isolated migrated test database. All provider traffic is mocked. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, pool } from "../src/db";
import { aiSettings, gameSessions, gameTurns, inventoryItems, memoryEmbeddings, memoryNodes, worldLocations } from "../src/db/schema";
import { performTurn } from "../src/lib/turn";
import { getAIConfig } from "../src/lib/ai-settings";
import { getTurnRequest } from "../src/lib/turn-admission";
import { writeMemoryNodes, upsertMemoryNode } from "../src/lib/memory";
import { indexPendingEmbeddings, searchMemory } from "../src/lib/embeddings";
import { prewarmSessionChoices, buildMemoryQuery } from "../src/lib/choice-prewarm";
import { emptyChanges } from "../src/lib/resolution";
import { mockSession } from "./ui-mock";
import { installSyntheticSecretKeyring } from "./lib/synthetic-secret-keyring";
import { sealSecret, secretContext } from "../src/lib/secret-vault";

const smokeKeyring = installSyntheticSecretKeyring("latency-smoke-v1");

async function main() {
  assert.equal(process.env.ARENA_ISOLATED_TEST_DB, "1", "Refusing to change settings outside an explicitly isolated test database");
  const nativeFetch = globalThis.fetch;
  let sessionId = "", embeddings = 0, generation = 0, receivedPrompt = "";
  let release!: () => void; const gate = new Promise<void>(r => { release=r; });
  let preview!: () => void; const previewReady = new Promise<void>(r => { preview=r; });
  const text = "Вы изучаете карту: гавань соединена дорогой с башней, за которой находится сад.";
  const payload = { narration: text, outcome: "neutral", choices: ["Осмотреть башню", "Изучить сад", "Вернуться"], effects: {hp:0,xp:0,gold:0,danger:0}, stateChanges: { ...emptyChanges(), locations: [{name:"Башня",description:"На карте к востоку от гавани",danger:20},{name:"Сад",description:"За башней",danger:10}], routes:[{from:"Тихая гавань",to:"Башня"},{from:"Башня",to:"Сад"}] } };
  const json = JSON.stringify(payload), cut = json.indexOf("гавань");
  const packet = (part: string, stop=false) => `data: ${JSON.stringify({candidates:[{content:{parts:[{text:part}]},...(stop?{finishReason:"STOP"}:{})}],...(stop?{usageMetadata:{promptTokenCount:100,candidatesTokenCount:80}}:{})})}\n\n`;
  globalThis.fetch = async (input, init) => {
    assert.ok(String(input).includes("generativelanguage.googleapis.com"), "No unexpected outbound traffic");
    const body = JSON.parse(String(init?.body));
    if (String(input).includes("embedContent") || String(input).includes("batchEmbedContents")) {
      embeddings++;
      const vector = { values: Array.from({length:128},(_,i)=>i===0?1:0) };
      return Response.json(body.requests?{embeddings:body.requests.map(()=>vector)}:{embedding:vector});
    }
    generation++; receivedPrompt=String(body.contents[0].parts[0].text);
    if (generation===1) return new Response("overloaded",{status:503});
    return new Response(new ReadableStream({async start(controller){
      controller.enqueue(new TextEncoder().encode(packet(json.slice(0,cut))));
      await gate;
      controller.enqueue(new TextEncoder().encode(packet(json.slice(cut),true))); controller.close();
    }}),{headers:{"Content-Type":"text/event-stream"}});
  };
  try {
    const storedKeys = ["fake-a", "fake-b"].map(key => sealSecret(key, secretContext(smokeOwnerId, "gemini"), smokeKeyring));
    await db.insert(aiSettings).values({id:smokeOwnerId,keys:storedKeys,useLiveAI:true,enforceLimits:false,embeddingsEnabled:true,embeddingDims:128,semanticExtractionEnabled:false}).onConflictDoUpdate({target:aiSettings.id,set:{keys:storedKeys,useLiveAI:true,enforceLimits:false,embeddingsEnabled:true,embeddingDims:128,semanticExtractionEnabled:false}});
    const [session] = await db.insert(gameSessions).values({ownerId:smokeOwnerId,title:"Isolated turn latency smoke",campaignMode:"free",rulesProfile:"narrative",turnCount:1,character:mockSession.character,worldState:mockSession.worldState}).returning(); sessionId=session.id;
    const action="Использовать «Набор инструментов»: изучить карту";
    await db.insert(gameTurns).values({sessionId,turnNumber:1,role:"narrator",content:"Вы в гавани.",choices:[action,"Осмотреться","Поговорить"]});
    await db.insert(worldLocations).values({sessionId,name:"Тихая гавань",current:true,discovered:true,x:0,y:0,connectedTo:[]});
    const [item] = await db.insert(inventoryItems).values({sessionId,name:"Набор инструментов",kind:"tool",quantity:1}).returning();
    await writeMemoryNodes(Array.from({length:8},(_,i)=>({sessionId,layer:"semantic" as const,category:"world",title:`Факт ${i}`,content:`Каноническое воспоминание ${i}`,importance:50,source:"seed" as const,sourceTurn:1,entityKey:`fact:${i}`})));
    const cfg=await getAIConfig(smokeOwnerId);
    await indexPendingEmbeddings({sessionId,keys:cfg.keys,model:cfg.embeddingModel,dims:128});
    await prewarmSessionChoices(sessionId); const warmedCalls=embeddings;
    const requestId=randomUUID();
    const input={sessionId,action,isFree:true,expectedTurn:1,requestId,itemIds:[item.id]};
    const queued: (()=>Promise<void>)[]=[];
    const running=performTurn(input,{loadAIConfig:async()=>cfg,onEvent:event=>{if(event.type==="narration" && event.text) preview();},schedule:job=>{queued.push(job);}});
    await Promise.race([previewReady,new Promise((_,reject)=>setTimeout(()=>reject(new Error("No incremental preview")),5000).unref())]);
    const before=await db.select().from(gameTurns).where(and(eq(gameTurns.sessionId,sessionId),eq(gameTurns.turnNumber,2)));
    assert.equal(before.length,0,"provisional text must not commit game state");
    release(); const result=await running; assert.ok(result.ok,JSON.stringify(result));
    assert.equal(generation,2,"alternate key succeeds before model fallback");
    assert.equal(embeddings,warmedCalls,"exact prewarmed choice avoids embedding on critical path");
    assert.ok(receivedPrompt.includes(item.id)); assert.equal(result.playerAction,action); assert.ok(!result.playerAction.includes(item.id));
    const map=await db.select().from(worldLocations).where(eq(worldLocations.sessionId,sessionId));
    const harbor=map.find(l=>l.name==="Тихая гавань")!,tower=map.find(l=>l.name==="Башня")!,garden=map.find(l=>l.name==="Сад")!;
    assert.ok(harbor.connectedTo?.includes(tower.id));assert.ok(tower.connectedTo?.includes(harbor.id));assert.ok(tower.connectedTo?.includes(garden.id));
    assert.equal(result.timings?.attempts,2);assert.ok(result.timings?.firstTextMs!==undefined);assert.ok(result.timings?.serverMs!==undefined);
    await queued.at(-1)!(); // Post-response complete timing persistence, not provider work.
    const saved=await getTurnRequest(sessionId,requestId);assert.equal(saved?.status,"completed");assert.equal(saved?.result?.narration,text);assert.equal(saved?.result?.timings?.serverMs,result.timings?.serverMs);
    const replay=await performTurn(input,{schedule:()=>{}});assert.ok(replay.ok && replay.replay);assert.equal(generation,2);
    const conflict=await performTurn({...input,itemIds:[randomUUID()]});assert.ok(!conflict.ok && conflict.code==="IDEMPOTENCY_CONFLICT");
    const query=buildMemoryQuery(action,mockSession.worldState.currentLocation,"Вы в гавани.");
    await searchMemory({sessionId,query,keys:cfg.keys,model:cfg.embeddingModel,dims:128});
    const newMemory=await upsertMemoryNode({sessionId,layer:"semantic",category:"world",title:"Новый важный факт",content:"Новая подтвержденная информация",importance:99,source:"state",sourceTurn:2,entityKey:"new:fresh"});
    await indexPendingEmbeddings({sessionId,keys:cfg.keys,model:cfg.embeddingModel,dims:128});const callsAfterIndex=embeddings;
    const fresh=await searchMemory({sessionId,query,keys:cfg.keys,model:cfg.embeddingModel,dims:128});
    assert.ok(fresh.results.some(node=>node.id===newMemory.id),"cached query must rank current memory");assert.equal(embeddings,callsAfterIndex);
    const outbox=await db.select().from(memoryEmbeddings).where(eq(memoryEmbeddings.sessionId,sessionId));
    const nodes=await db.select().from(memoryNodes).where(eq(memoryNodes.sessionId,sessionId));assert.equal(outbox.length,nodes.length);
    console.log("PASS: incremental generation before commit; atomic map routes; hidden item binding; overload/key retry; durable replay; exact prewarm; fresh retrieval; memory outbox; phase telemetry", result.timings);
  } finally {
    release();globalThis.fetch=nativeFetch;
    if(sessionId) await db.delete(gameSessions).where(eq(gameSessions.id,sessionId));
    await cleanupSmokeIdentity();
    await pool.end();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
