import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AIConfig } from "../src/lib/ai-settings";
import { emptyChanges } from "../src/lib/resolution";
import { readLife } from "../src/lib/world-life";
import { accountsDb } from "./helpers/accounts-db";

const character = { name: "Ада", archetype: "Горожанка", level: 1, xp: 0, hp: 20, maxHp: 20, gold: 5, stats: {}, skills: [], traits: [], conditions: [], backstory: "", appearance: "" };
const world = { worldName: "Город", tone: "повседневность", era: "наши дни", mainQuest: "", currentLocation: "Кафе", factions: [], flags: {}, danger: 0, chapter: 1, clock: { day: 1, minute: 540 } };
const cfg: AIConfig = { keys: [], dbKeyCount: 0, envKeyCount: 0, useLiveAI: true, canUseLive: true, textProvider: "openrouter", textModel: "synthetic/story", textApiKey: "synthetic-key", routingConfig: { profile: "balanced", narrationModel: "gemini-3.5-flash-lite", customActionModel: "gemini-3.8-flash", compactionModel: "gemini-3.8-flash", fastTaskModel: "gemini-3.5-flash-lite" }, limits: { flash: 20, lite: 500 }, enforceLimits: false, embeddingsEnabled: false, embeddingModel: "gemini-embedding-2", embeddingDims: 768, semanticExtractionEnabled: false };

// Catches the life reducer receiving the pre-resolution NPC/map snapshot: transfers must
// obey the same accepted status, presence and destination that the transaction persists.
test("performTurn keeps life consequences consistent with accepted entity changes", async t => {
  const { performTurn } = await import("../src/lib/turn");
  const fixture = await accountsDb();
  const { pg } = fixture;
  try {
    for (const row of [
      { name: "NPC became dead", existing: true, status: "dead", newPlace: false, accepted: false },
      { name: "NPC became missing", existing: true, status: "missing", newPlace: false, accepted: false },
      { name: "newly met NPC", existing: false, status: "alive", newPlace: false, accepted: true },
      { name: "NPC met at the new destination", existing: true, status: "alive", newPlace: true, accepted: true },
      { name: "new destination holding", existing: false, status: null, newPlace: true, accepted: true },
    ] as const) await t.test(row.name, async () => {
      const sessionId = randomUUID(), itemId = randomUUID(), cafeId = randomUUID();
      await pg.query("INSERT INTO game_sessions(id,title,campaign_mode,rules_profile,character,world_state,turn_count,owner_id) VALUES ($1,'Transfer state','free','narrative',$2,$3,1,'transfer-state-fixture')", [sessionId, JSON.stringify(character), JSON.stringify(world)]);
      await pg.query("INSERT INTO inventory_items(id,session_id,name,kind,quantity) VALUES ($1,$2,'Книга','misc',1)", [itemId, sessionId]);
      await pg.query("INSERT INTO world_locations(id,session_id,name,current,discovered,x,y) VALUES ($1,$2,'Кафе',true,true,5,5)", [cafeId, sessionId]);
      if (row.existing) await pg.query("INSERT INTO npcs(session_id,key,name,status,last_location) VALUES ($1,'anna','Анна','alive','Кафе')", [sessionId]);
      const narration = "Ты смотришь на книгу и решаешь, кому её передать.";
      const to = row.status === null ? "Парк" : "Анна";
      const draft = { continuity: { mode: "event", referencesPast: false }, narration, choices: ["Осмотреться"], outcome: "neutral", effects: { hp: 0, xp: 0, gold: 0, danger: 0 }, stateChanges: {
        ...emptyChanges(),
        ...(row.newPlace ? { location: { action: "move", name: "Парк", ref: null, description: "Тихий парк", danger: 0 } } : {}),
        npcs: row.status ? [{ ref: row.existing ? "anna" : null, name: "Анна", role: "подруга", relationDelta: 0, status: row.status, note: "Исход сцены" }] : [],
        transfers: [{ ref: itemId, to, quantity: 1, accepted: true }],
      } };
      const fetchMock = mock.method(globalThis, "fetch", async () => Response.json({ choices: [{ message: { content: JSON.stringify(draft) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
      try {
        const result = await performTurn({ sessionId, requestId: randomUUID(), expectedTurn: 1, isFree: true, action: "Передаю книгу получателю" }, {
          loadAIConfig: async () => cfg, loadNarrativeConfig: async () => ({ enabled: false, provider: "openrouter", apiKey: "" }), schedule() {}, scheduleDiagnostics() {},
        });
        assert.ok(result.ok, JSON.stringify(result));
        assert.equal(result.applied.life?.transfers[0]?.ok, row.accepted);
        assert.equal((await pg.query("SELECT id FROM inventory_items WHERE session_id=$1", [sessionId])).rows.length, row.accepted ? 0 : 1);
        const saved = (await pg.query<{ world_state: typeof world }>("SELECT world_state FROM game_sessions WHERE id=$1", [sessionId])).rows[0].world_state;
        assert.deepEqual(saved, result.state?.worldState);
        const holdings = readLife(saved).holdings;
        assert.equal(holdings.length, row.accepted ? 1 : 0);
        if (row.accepted) {
          assert.equal(holdings[0].holderName, to);
          assert.equal(holdings[0].quantity, 1);
          if (row.status === null) assert.equal((await pg.query<{ name: string }>("SELECT name FROM world_locations WHERE id=$1", [holdings[0].holderKey])).rows[0]?.name, "Парк");
          else assert.equal((await pg.query<{ status: string }>("SELECT status FROM npcs WHERE session_id=$1 AND key=$2", [sessionId, holdings[0].holderKey])).rows[0]?.status, "alive");
        }
        const ownershipMemory = (await pg.query("SELECT id FROM memory_nodes WHERE session_id=$1 AND entity_key='holding:книга'", [sessionId])).rows;
        assert.equal(ownershipMemory.length, row.accepted ? 1 : 0);
      } finally { fetchMock.mock.restore(); }
    });
    for (const completedKey of ["side", "main"]) await t.test(`only the main quest closes the story arc: complete ${completedKey}`, async () => {
      const sessionId = randomUUID(), mainId = randomUUID(), sideId = randomUUID();
      const arcWorld = { ...world, mainQuest: "Доставить письмо", story: { kind: "arc", goal: "Доставить письмо", endCondition: "Письмо доставлено адресату", stakes: "", conflict: "", focus: [], status: "ongoing" } };
      await pg.query("INSERT INTO game_sessions(id,title,campaign_mode,rules_profile,character,world_state,turn_count,owner_id) VALUES ($1,'Quest identity','free','narrative',$2,$3,1,'quest-state-fixture')", [sessionId, JSON.stringify(character), JSON.stringify(arcWorld)]);
      await pg.query("INSERT INTO quests(id,session_id,key,title,status,is_main) VALUES ($1,$2,'main','Доставить письмо','active',true),($3,$2,'side','Доставить письмо','active',false)", [mainId, sessionId, sideId]);
      const draft = { continuity: { mode: "event", referencesPast: false }, narration: "Ты передал письмо адресату.", choices: ["Продолжить путь"], outcome: "neutral", effects: { hp: 0, xp: 0, gold: 0, danger: 0 }, stateChanges: { ...emptyChanges(), quests: [{ ref: completedKey, title: "Доставить письмо", status: "completed", progress: 100 }] } };
      const fetchMock = mock.method(globalThis, "fetch", async () => Response.json({ choices: [{ message: { content: JSON.stringify(draft) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
      try {
        const result = await performTurn({ sessionId, requestId: randomUUID(), expectedTurn: 1, isFree: true, action: "Передаю второе письмо соседу" }, {
          loadAIConfig: async () => cfg, loadNarrativeConfig: async () => ({ enabled: false, provider: "openrouter", apiKey: "" }), schedule() {}, scheduleDiagnostics() {},
        });
        assert.ok(result.ok, JSON.stringify(result));
        assert.deepEqual((await pg.query("SELECT id,status FROM quests WHERE session_id=$1 ORDER BY key", [sessionId])).rows, [{ id: mainId, status: completedKey === "main" ? "completed" : "active" }, { id: sideId, status: completedKey === "side" ? "completed" : "active" }]);
        assert.equal(readLife(result.state!.worldState).story.status, completedKey === "main" ? "resolved" : "ongoing");
        assert.equal(result.state!.worldState.chapter, completedKey === "main" ? 2 : 1);
        assert.equal((await pg.query("SELECT id FROM memory_nodes WHERE session_id=$1 AND entity_key='story:arc'", [sessionId])).rows.length, completedKey === "main" ? 1 : 0);
        const saved = (await pg.query<{ world_state: typeof world }>("SELECT world_state FROM game_sessions WHERE id=$1", [sessionId])).rows[0].world_state;
        assert.deepEqual(saved, result.state!.worldState);
      } finally { fetchMock.mock.restore(); }
    });
    await t.test("deferred work from an old owner cannot initialize settings or worker state for an adopted campaign", async () => {
      const sessionId = randomUUID(), oldOwner = `old-${randomUUID()}`, newOwner = `new-${randomUUID()}`;
      await pg.query("INSERT INTO game_sessions(id,title,campaign_mode,rules_profile,character,world_state,turn_count,owner_id) VALUES ($1,'Deferred ownership','free','narrative',$2,$3,1,$4)", [sessionId, JSON.stringify(character), JSON.stringify(world), oldOwner]);
      const draft = { continuity: { mode: "event", referencesPast: false }, narration: "Ты наблюдаешь за посетителями кафе.", choices: ["Осмотреться"], outcome: "neutral", effects: { hp: 0, xp: 0, gold: 0, danger: 0 }, stateChanges: emptyChanges() };
      const jobs: (() => Promise<void>)[] = [];
      const fetchMock = mock.method(globalThis, "fetch", async () => Response.json({ choices: [{ message: { content: JSON.stringify(draft) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
      try {
        const result = await performTurn({ sessionId, requestId: randomUUID(), expectedTurn: 1, isFree: true, action: "Осматриваю кафе" }, {
          loadAIConfig: async () => cfg, loadNarrativeConfig: async () => ({ enabled: false, provider: "openrouter", apiKey: "" }), schedule: job => jobs.push(job), scheduleDiagnostics() {},
        });
        assert.ok(result.ok, JSON.stringify(result));
        assert.ok(jobs.length >= 2);
        await pg.query("UPDATE game_sessions SET owner_id=$2 WHERE id=$1", [sessionId, newOwner]);
        for (const job of jobs) await job();
        assert.equal((await pg.query("SELECT id FROM ai_settings WHERE id=$1", [newOwner])).rows.length, 0);
        assert.equal((await pg.query("SELECT id FROM worker_heartbeats WHERE id=$1", [`memory:after:${newOwner}`])).rows.length, 0);
        assert.equal((await pg.query("SELECT id FROM owner_activity WHERE owner_id=$1", [oldOwner])).rows.length, 0);
      } finally { fetchMock.mock.restore(); }
    });
  } finally { await fixture.close(); }
});
