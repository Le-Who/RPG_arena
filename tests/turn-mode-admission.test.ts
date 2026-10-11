import "./helpers/test-environment";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountsDb } from "./helpers/accounts-db";
import type { AIConfig } from "../src/lib/ai-settings";

const character = { name: "Ада", archetype: "Путник", level: 1, xp: 0, hp: 20, maxHp: 20, gold: 5, stats: { СИЛ: 10, ЛОВ: 10, ВЫН: 10, ИНТ: 10, МУД: 10, ХАР: 10 }, skills: [], traits: [], conditions: [], backstory: "", appearance: "" };
const world = { worldName: "Город", tone: "Спокойный", era: "Сегодня", mainQuest: "Найти письмо", currentLocation: "Площадь", factions: [], flags: {}, danger: 0, chapter: 1 };
const action = "Взломать замок";
const config: AIConfig = {
  keys: [], dbKeyCount: 0, envKeyCount: 0, useLiveAI: false, canUseLive: false,
  routingConfig: { profile: "balanced", narrationModel: "gemini-3.5-flash-lite", customActionModel: "gemini-3.8-flash", compactionModel: "gemini-3.8-flash", fastTaskModel: "gemini-3.5-flash-lite" },
  limits: { flash: 20, lite: 500 }, enforceLimits: false, embeddingsEnabled: false,
  embeddingModel: "gemini-embedding-2", embeddingDims: 768, semanticExtractionEnabled: false,
};
const expectedDice = {
  d20: { kind: "d20", d20: 20, modifier: 0, total: 20, dc: 10, success: true, critical: "crit", skill: "Взлом", band: "full", label: "КРИТ! d20=20 (Взлом)", goal: action },
  "rules-light": { kind: "2d6", d20: 66, modifier: 0, total: 12, dc: 7, success: true, critical: "crit", skill: "Риск", band: "full", label: "Полный успех 6+6 (Риск)", goal: action },
  narrative: null,
};

test("campaign mode controls offline commit and both input modes reuse the admitted profile check", async t => {
  const database = await accountsDb();
  const { performTurn } = await import("../src/lib/turn");
  const runtime = { loadAIConfig: async () => config, loadNarrativeConfig: async () => ({ enabled: false, provider: "openrouter" as const, apiKey: "" }), schedule() {}, scheduleDiagnostics() {} };
  try {
    for (const profile of ["d20", "rules-light", "narrative"] as const) {
      for (const mode of ["preset", "free"] as const) {
        for (const isFree of [false, true]) await t.test(`${mode}/${profile}/${isFree ? "typed" : "suggested"}: absent provider respects campaign and check policy`, async () => {
          const sessionId = randomUUID(), requestId = randomUUID();
          await database.pg.query("INSERT INTO game_sessions(id,title,scenario_title,campaign_mode,rules_profile,character,world_state,turn_count,owner_id) VALUES ($1,'Mode fixture','Mode fixture',$2,$3,$4,$5,1,$6)", [sessionId, mode, profile, JSON.stringify(character), JSON.stringify(world), `mode-owner-${sessionId}`]);
          await database.pg.query("INSERT INTO game_turns(session_id,turn_number,role,content,choices) VALUES ($1,1,'narrator','Перед тобой закрытая дверь.',$2)", [sessionId, JSON.stringify([action])]);
          const before = (await database.pg.query("SELECT * FROM game_sessions WHERE id=$1", [sessionId])).rows;
          const random = mock.method(Math, "random", () => 0.95);
          const fetch = mock.method(globalThis, "fetch", async () => { throw new Error("Credential-free mode fixture called a provider"); });
          try {
            const result = await performTurn({ sessionId, requestId, expectedTurn: 1, action, isFree }, runtime);
            const expectedCalls = profile === "d20" ? 1 : profile === "rules-light" ? 2 : 0;
            assert.equal(random.mock.callCount(), expectedCalls, "one admitted check, no second roll in offline engine");
            assert.equal(fetch.mock.callCount(), 0);
            const requests = (await database.pg.query<{ status: string; dice: unknown; attempts: number }>("SELECT status,dice,attempts FROM turn_requests WHERE session_id=$1 AND request_id=$2", [sessionId, requestId])).rows;
            assert.equal(requests.length, 1);
            assert.deepEqual(requests[0].dice, expectedDice[profile]);
            assert.equal(requests[0].attempts, 1);
            if (mode === "free") {
              assert.deepEqual(result, { ok: false, code: "AI_REQUIRED", message: "Для свободной кампании подключите провайдера рассказчика и включите живой ИИ в настройках." });
              assert.equal(requests[0].status, "failed");
              assert.deepEqual((await database.pg.query("SELECT * FROM game_sessions WHERE id=$1", [sessionId])).rows, before);
              const turns = (await database.pg.query("SELECT turn_number,role,content FROM game_turns WHERE session_id=$1 ORDER BY turn_number,role", [sessionId])).rows;
              assert.deepEqual(turns, [{ turn_number: 1, role: "narrator", content: "Перед тобой закрытая дверь." }]);
              for (const table of ["memory_nodes", "memory_jobs", "memory_embeddings", "model_call_quotas"]) {
                const column = table === "model_call_quotas" ? "owner_id" : "session_id";
                const key = table === "model_call_quotas" ? `mode-owner-${sessionId}` : sessionId;
                assert.equal((await database.pg.query<{ n: number }>(`SELECT count(*)::int n FROM ${table} WHERE ${column}=$1`, [key])).rows[0].n, 0);
              }
            } else {
              assert.ok(result.ok, JSON.stringify(result));
              assert.equal(result.turnNumber, 2);
              assert.equal(result.modelUsed, "offline-engine");
              assert.deepEqual(result.dice, expectedDice[profile]);
              assert.equal((await database.pg.query<{ turn_count: number }>("SELECT turn_count FROM game_sessions WHERE id=$1", [sessionId])).rows[0].turn_count, 2);
              const turns = (await database.pg.query<{ role: string; dice: unknown }>("SELECT role,dice FROM game_turns WHERE session_id=$1 AND turn_number=2 ORDER BY role", [sessionId])).rows;
              assert.deepEqual(turns, [{ role: "narrator", dice: expectedDice[profile] }, { role: "player", dice: null }]);
              assert.equal(requests[0].status, "completed");
              const replay = await performTurn({ sessionId, requestId, expectedTurn: 1, action, isFree }, runtime);
              assert.ok(replay.ok);
              assert.equal(replay.replay, true);
              assert.deepEqual(replay.dice, expectedDice[profile]);
              assert.equal(random.mock.callCount(), expectedCalls, "completed replay does not roll again");
              assert.equal((await database.pg.query<{ n: number }>("SELECT count(*)::int n FROM game_turns WHERE session_id=$1 AND turn_number=2", [sessionId])).rows[0].n, 2);
            }
          } finally { fetch.mock.restore(); random.mock.restore(); }
        });
      }
    }
  } finally { await database.close(); }
});
