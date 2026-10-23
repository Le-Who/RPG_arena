import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { accountsDb } from "./helpers/accounts-db";
import { getAIConfig } from "../src/lib/ai-settings";
import { enqueueSemanticJob, processSemanticJob } from "../src/lib/memory-jobs";
import { db } from "../src/db";

const phrase = "Лена обещает встретить героя на рассвете.";
const fact = { type: "promise", title: "Встреча", content: phrase, evidence: phrase, confidence: .9, importance: 70, entityKey: "promise:lena" };
function response(text: string) {
  return Response.json({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 } });
}
async function setup() {
  const f = await accountsDb(), sessionId = randomUUID(), owner = `memory-owner-${sessionId}`;
  await f.pg.query("INSERT INTO ai_settings(id,enforce_limits) VALUES ($1,false)", [owner]);
  await f.pg.query("INSERT INTO game_sessions(id,owner_id,title,campaign_mode,rules_profile,character,world_state,turn_count) VALUES ($1,$2,'Memory worker','free','rules-light',$3,$4,1)", [sessionId, owner,
    JSON.stringify({ name: "Искатель", archetype: "Путник", hp: 1, maxHp: 20, level: 1, xp: 0, gold: 20, stats: {}, skills: [], traits: [], conditions: [], backstory: "", appearance: "" }),
    JSON.stringify({ worldName: "Гавань", tone: "Повседневность", era: "Сегодня", mainQuest: "Встретить Лену", currentLocation: "Причал", factions: [], flags: {}, danger: 0, chapter: 1 })]);
  const cfg = { ...await getAIConfig(owner), keys: ["synthetic-memory-transport"], canUseLive: true, useLiveAI: true, semanticExtractionEnabled: true, embeddingsEnabled: false };
  const enqueue = () => db.transaction(tx => enqueueSemanticJob(tx, { sessionId, turnNumber: 2, payload: { narration: phrase, playerAction: "Лена передала герою ключ от квартиры.", profileCanon: "narrative", knownDigest: "" } }));
  const snapshot = async () => ({
    nodes: (await f.pg.query<{ entity_key: string; content: string; evidence: string | null; source: string; source_turn: number }>("SELECT entity_key,content,evidence,source,source_turn FROM memory_nodes WHERE session_id=$1 ORDER BY entity_key", [sessionId])).rows,
    embeddings: (await f.pg.query("SELECT memory_node_id,content_hash,status,attempts FROM memory_embeddings WHERE session_id=$1 ORDER BY memory_node_id", [sessionId])).rows,
  });
  return { ...f, sessionId, cfg, enqueue, snapshot };
}

test("accepted server consequence narration reaches the semantic worker with the exact committed hash", async () => {
  // Catches queuing the pre-consequence draft instead of the complete accepted narrator text.
  const f = await setup();
  const accepted = "Лена обещает встретить героя на рассвете.\n\n💀 Искатель на грани гибели. История не обрывается — но цена уплачена (−10 средств).";
  const acceptedHash = "4d5c428f339570616c90c2d44845dded15cccf8ee45af9665cbdb162afdf0bf2";
  let phase: "turn" | "worker" = "turn", workerInput = "";
  const fetch = mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    if (phase === "worker") {
      const body = JSON.parse(String(init?.body));
      workerInput = body.contents[0].parts[0].text;
      return response(JSON.stringify({ facts: [fact] }));
    }
    return response(JSON.stringify({ narration: phrase, choices: ["Осмотреться"], outcome: "neutral", effects: { hp: -5, xp: 0, gold: 0, danger: 0 }, stateChanges: { location: null, locations: [], routes: [], quests: [], npcs: [], inventory: [], sceneObjects: [], conditions: { add: [], remove: [] }, flags: {} } }));
  });
  try {
    const { performTurn } = await import("../src/lib/turn");
    const result = await performTurn({ sessionId: f.sessionId, requestId: randomUUID(), expectedTurn: 1, action: "Осмотреться", isFree: true }, {
      loadAIConfig: async () => f.cfg, loadNarrativeConfig: async () => ({ enabled: false, provider: "openrouter", apiKey: "" }), schedule() {}, scheduleDiagnostics() {},
    });
    if (!result.ok) throw new Error(result.message);
    assert.equal(result.ok, true);
    assert.equal(result.dead, true);
    assert.equal(result.narration, accepted);
    const narrator = (await f.pg.query<{ content: string }>("SELECT content FROM game_turns WHERE session_id=$1 AND role='narrator'", [f.sessionId])).rows[0];
    const job = (await f.pg.query<{ payload: { narration: string } }>("SELECT payload FROM memory_jobs WHERE session_id=$1", [f.sessionId])).rows[0];
    assert.equal(createHash("sha256").update(narrator.content).digest("hex"), acceptedHash);
    assert.equal(createHash("sha256").update(job.payload.narration).digest("hex"), acceptedHash);
    phase = "worker";
    assert.deepEqual(await processSemanticJob({ sessionId: f.sessionId, cfg: f.cfg }), { processed: 1, extracted: 1, failed: 0, delayed: false });
    assert.equal(workerInput, `Действие игрока (намерение, не доказательство): Осмотреться\n\nПодтверждённый ответ рассказчика:\n${accepted}`);
    assert.deepEqual((await f.snapshot()).nodes.filter(row => row.source === "ai-semantic"), [{ entity_key: "promise:lena", content: phrase, evidence: phrase, source: "ai-semantic", source_turn: 2 }]);
  } finally { fetch.mock.restore(); await f.close(); }
});

test("invalid extraction JSON leaves canonical memories and embedding outbox untouched", async () => {
  // Catches treating malformed envelopes as successful partial writes or losing the retry state.
  const f = await setup(); let providerText = "";
  const fetch = mock.method(globalThis, "fetch", async () => response(providerText));
  try {
    await f.enqueue(); const before = await f.snapshot();
    for (const text of ["not json", '{"facts":{}}']) {
      providerText = text;
      const result = await processSemanticJob({ sessionId: f.sessionId, cfg: f.cfg });
      assert.deepEqual(result, { processed: 0, extracted: 0, failed: 0, delayed: true });
      assert.deepEqual(await f.snapshot(), before);
      assert.deepEqual((await f.pg.query("SELECT status,error,facts_count,lease_token FROM memory_jobs WHERE session_id=$1", [f.sessionId])).rows, [{ status: "pending", error: "INVALID_EXTRACTION_JSON", facts_count: 0, lease_token: null }]);
      await f.pg.query("UPDATE memory_jobs SET next_attempt_at=now() WHERE session_id=$1", [f.sessionId]);
    }
  } finally { fetch.mock.restore(); await f.close(); }
});

test("malformed individual facts and player intentions never become canonical evidence", async () => {
  // Catches weakening fact validation or using the intention as evidence; valid sibling facts remain accepted.
  const f = await setup();
  const fetch = mock.method(globalThis, "fetch", async () => response(JSON.stringify({ facts: [null, { ...fact, entityKey: "invalid-confidence:lena", title: "Невалидная уверенность", confidence: "0.9" }, { ...fact, evidence: "Лена передала герою ключ от квартиры.", content: "Лена передала герою ключ от квартиры." }, fact] })));
  try {
    await f.enqueue();
    const result = await processSemanticJob({ sessionId: f.sessionId, cfg: f.cfg });
    assert.deepEqual((await f.snapshot()).nodes, [{ entity_key: "promise:lena", content: phrase, evidence: phrase, source: "ai-semantic", source_turn: 2 }]);
    assert.deepEqual(result, { processed: 1, extracted: 1, failed: 0, delayed: false });
    assert.equal((await f.snapshot()).embeddings.length, 1);
    assert.deepEqual((await f.pg.query("SELECT status,facts_count,lease_token FROM memory_jobs WHERE session_id=$1", [f.sessionId])).rows, [{ status: "completed", facts_count: 1, lease_token: null }]);
    assert.equal((await processSemanticJob({ sessionId: f.sessionId, cfg: f.cfg })).processed, 0);
  } finally { fetch.mock.restore(); await f.close(); }
});

test("semantic worker rejects state-owned resources even when extraction labels them character facts", async () => {
  const f = await setup();
  const resource = "Герой получил 500 XP.";
  const fetch = mock.method(globalThis, "fetch", async () => response(JSON.stringify({ facts: [
    { ...fact, type: "character", entityKey: "character:experience", content: resource, evidence: resource },
    fact,
  ] })));
  try {
    await db.transaction(tx => enqueueSemanticJob(tx, { sessionId: f.sessionId, turnNumber: 2,
      payload: { narration: `${resource} ${phrase}`, playerAction: "Осматриваюсь", profileCanon: "rules-light", knownDigest: "" } }));
    assert.deepEqual(await processSemanticJob({ sessionId: f.sessionId, cfg: f.cfg }), { processed: 1, extracted: 1, failed: 0, delayed: false });
    assert.deepEqual((await f.snapshot()).nodes, [{ entity_key: "promise:lena", content: phrase, evidence: phrase, source: "ai-semantic", source_turn: 2 }]);
    assert.equal((await f.snapshot()).embeddings.length, 1);
  } finally { fetch.mock.restore(); await f.close(); }
});

test("an expired extraction lease cannot write supported facts or acknowledge the job", async () => {
  // Catches dropping the expiry check at the canonical transaction fence.
  const f = await setup();
  const fetch = mock.method(globalThis, "fetch", async () => {
    await f.pg.query("UPDATE memory_jobs SET lease_expires_at='2000-01-01' WHERE session_id=$1", [f.sessionId]);
    return response(JSON.stringify({ facts: [fact] }));
  });
  try {
    await f.enqueue(); const before = await f.snapshot();
    assert.deepEqual(await processSemanticJob({ sessionId: f.sessionId, cfg: f.cfg }), { processed: 0, extracted: 0, failed: 0, delayed: false });
    assert.deepEqual(await f.snapshot(), before);
    assert.deepEqual((await f.pg.query("SELECT status,facts_count,attempts FROM memory_jobs WHERE session_id=$1", [f.sessionId])).rows, [{ status: "processing", facts_count: 0, attempts: 1 }]);
  } finally { fetch.mock.restore(); await f.close(); }
});

for (const phase of ["admission", "acknowledgement", "failure"] as const) test(`semantic lease expiry at delayed ${phase} SQL fences every durable effect`, async () => {
  const f = await setup();
  const fetch = mock.method(globalThis, "fetch", async () => phase === "failure" ? new Response("Unavailable", { status: 503 }) : response(JSON.stringify({ facts: [fact] })));
  const realQuery = f.pg.query.bind(f.pg);
  let delayed = false;
  const query = mock.method(f.pg, "query", (async (...args: Parameters<typeof f.pg.query>) => {
    const sql = args[0], values = args[1] as unknown[] | undefined;
    const selected = phase === "admission" ? sql.startsWith('select "id" from "memory_jobs"')
      : sql.startsWith('update "memory_jobs" set') && values?.[0] === (phase === "failure" ? "pending" : "completed");
    if (!delayed && selected) {
      delayed = true;
      // The ORM predicate is already built. Move expiry just beyond that client
      // timestamp, then let SQL execute after the database deadline has passed.
      await realQuery("UPDATE memory_jobs SET lease_expires_at=clock_timestamp()+interval '50 milliseconds' WHERE session_id=$1", [f.sessionId]);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return realQuery(...args);
  }) as never);
  try {
    await f.enqueue(); const before = await f.snapshot();
    const result = await processSemanticJob({ sessionId: f.sessionId, cfg: f.cfg });
    assert.equal(delayed, true);
    assert.equal(result.processed, 0);
    assert.equal(result.extracted, 0);
    assert.deepEqual(await f.snapshot(), before);
    assert.deepEqual((await f.pg.query("SELECT status,facts_count,attempts,lease_token IS NOT NULL AS claimed FROM memory_jobs WHERE session_id=$1", [f.sessionId])).rows,
      [{ status: "processing", facts_count: 0, attempts: 1, claimed: true }]);
  } finally { query.mock.restore(); fetch.mock.restore(); await f.close(); }
});

test("a fresh semantic claim completes under a non-UTC database timezone", async () => {
  const f = await setup();
  const fetch = mock.method(globalThis, "fetch", async () => response(JSON.stringify({ facts: [fact] })));
  try {
    await f.enqueue();
    // Existing queue defaults are persisted in UTC. Change only the execution
    // timezone after enqueueing to isolate the lease comparison under test.
    await f.pg.exec("SET TIME ZONE 'Asia/Tokyo'");
    assert.deepEqual(await processSemanticJob({ sessionId: f.sessionId, cfg: f.cfg }), { processed: 1, extracted: 1, failed: 0, delayed: false });
    assert.deepEqual((await f.pg.query("SELECT status,facts_count,lease_token FROM memory_jobs WHERE session_id=$1", [f.sessionId])).rows, [{ status: "completed", facts_count: 1, lease_token: null }]);
  } finally { fetch.mock.restore(); await f.close(); }
});

test("a semantic job enqueued under a non-UTC timezone is immediately claimable", async () => {
  const f = await setup();
  const fetch = mock.method(globalThis, "fetch", async () => response(JSON.stringify({ facts: [fact] })));
  try {
    await f.pg.exec("SET TIME ZONE 'Asia/Tokyo'");
    await f.enqueue();
    assert.deepEqual(await processSemanticJob({ sessionId: f.sessionId, cfg: f.cfg }), { processed: 1, extracted: 1, failed: 0, delayed: false });
    assert.deepEqual((await f.pg.query("SELECT status,facts_count FROM memory_jobs WHERE session_id=$1", [f.sessionId])).rows, [{ status: "completed", facts_count: 1 }]);
  } finally { fetch.mock.restore(); await f.close(); }
});

test("failed job acknowledgement rolls back facts and their embedding rows together", async () => {
  // Catches memory/outbox writes escaping the transaction that marks extraction complete.
  const f = await setup();
  const fetch = mock.method(globalThis, "fetch", async () => response(JSON.stringify({ facts: [fact] })));
  const sqlFailures: string[] = [], realQuery = f.pg.query.bind(f.pg);
  const query = mock.method(f.pg, "query", (async (...args: Parameters<typeof f.pg.query>) => {
    try { return await realQuery(...args); }
    catch (error) { sqlFailures.push(error instanceof Error ? error.message : String(error)); throw error; }
  }) as never);
  try {
    await f.enqueue(); const before = await f.snapshot();
    await f.pg.exec(`CREATE FUNCTION reject_memory_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.status='completed' THEN
        IF NOT EXISTS (SELECT 1 FROM memory_nodes WHERE session_id=NEW.session_id AND source='ai-semantic') OR
           NOT EXISTS (SELECT 1 FROM memory_embeddings WHERE session_id=NEW.session_id) THEN
          RAISE EXCEPTION 'completion reached without prior canonical writes';
        END IF;
        RAISE EXCEPTION 'synthetic memory completion failure after canonical writes';
      END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_memory_completion BEFORE UPDATE ON memory_jobs FOR EACH ROW EXECUTE FUNCTION reject_memory_completion();`);
    assert.deepEqual(await processSemanticJob({ sessionId: f.sessionId, cfg: f.cfg }), { processed: 0, extracted: 0, failed: 0, delayed: true });
    assert.deepEqual(sqlFailures, ["synthetic memory completion failure after canonical writes"]);
    assert.deepEqual(await f.snapshot(), before);
    assert.deepEqual((await f.pg.query("SELECT status,facts_count,attempts,lease_token FROM memory_jobs WHERE session_id=$1", [f.sessionId])).rows, [{ status: "pending", facts_count: 0, attempts: 1, lease_token: null }]);
  } finally { query.mock.restore(); fetch.mock.restore(); await f.close(); }
});
