import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountsDb } from "./helpers/accounts-db";
import type { AIConfig } from "../src/lib/ai-settings";

test("Gemini rejection explains the remedy without committing the turn or exposing the error body", async t => {
  const f = await accountsDb();
  const owner = "guest:synthetic-gemini-recovery";
  await f.pg.query("INSERT INTO ai_settings(id,keys) VALUES ($1,'[]')", [owner]);
  const cfg: AIConfig = {
    ownerId: owner, keys: ["synthetic-key"], dbKeyCount: 1, envKeyCount: 0,
    textProvider: "gemini", useLiveAI: true, canUseLive: true,
    routingConfig: { profile: "economy", narrationModel: "gemini-3.5-flash-lite", customActionModel: "gemini-3.5-flash-lite", compactionModel: "gemini-3.8-flash", fastTaskModel: "gemini-3.5-flash-lite" },
    limits: { flash: 20, lite: 500 }, enforceLimits: false,
    embeddingsEnabled: false, embeddingModel: "gemini-embedding-2", embeddingDims: 128, semanticExtractionEnabled: false,
  };
  const character = { name: "Искатель", archetype: "Путник", level: 1, xp: 0, hp: 20, maxHp: 20, gold: 5, stats: {}, skills: [], traits: [], conditions: [], backstory: "", appearance: "" };
  const world = { worldName: "Гавань", tone: "Спокойный", era: "Сегодня", mainQuest: "Осмотреться", currentLocation: "Причал", factions: [], flags: {}, danger: 0, chapter: 1 };
  try {
    const { performTurn } = await import("../src/lib/turn");
    const { embedTexts } = await import("../src/lib/embeddings");
    for (const reason of ["API_KEY_INVALID", "INVALID_ARGUMENT"]) await t.test(reason, async t => {
      const sessionId = randomUUID(), requestId = randomUUID();
      await f.pg.query("INSERT INTO game_sessions(id,title,campaign_mode,rules_profile,character,world_state,turn_count,owner_id) VALUES ($1,'Synthetic','free','narrative',$2,$3,1,$4)", [sessionId, JSON.stringify(character), JSON.stringify(world), owner]);
      let requests = 0;
      t.mock.method(globalThis, "fetch", async () => { requests++; return Response.json({ error: {
        status: "INVALID_ARGUMENT", message: "PRIVATE_BODY_MARKER", details: reason === "API_KEY_INVALID"
          ? [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, metadata: { key: "PRIVATE_KEY_MARKER" } }] : [],
      } }, { status: 400 }); });
      const result = await performTurn({ sessionId, requestId, expectedTurn: 1, isFree: true, action: "Смотрю на воду" }, {
        loadAIConfig: async () => cfg, loadNarrativeConfig: async () => ({ enabled: false, provider: "openrouter", apiKey: "" }), schedule() {}, scheduleDiagnostics() {},
      });
      assert.equal(result.ok, false);
      assert.ok(!result.ok);
      assert.equal(result.code, "AI_FAILED");
      assert.match(result.message, reason === "API_KEY_INVALID" ? /ключ/i : /параметр|запрос/i);
      assert.doesNotMatch(result.message, /через минуту/);
      assert.match(result.details ?? "", new RegExp(`HTTP 400: ${reason}$`));
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
      assert.equal(requests, 4, "all configured fallback models are still attempted");
      assert.equal((await f.pg.query<{ turn_count: number }>("SELECT turn_count FROM game_sessions WHERE id=$1", [sessionId])).rows[0].turn_count, 1);
      assert.equal((await f.pg.query("SELECT id FROM game_turns WHERE session_id=$1", [sessionId])).rows.length, 0);
      assert.equal((await f.pg.query<{ status: string }>("SELECT status FROM turn_requests WHERE request_id=$1", [requestId])).rows[0].status, "failed");
      await assert.rejects(embedTexts({ sessionId, keys: cfg.keys, model: cfg.embeddingModel, dims: 128, texts: ["Synthetic memory"] }), new RegExp(`HTTP 400: ${reason}$`));
      const errors = (await f.pg.query<{ error: string }>("SELECT error FROM token_logs WHERE session_id=$1", [sessionId])).rows;
      assert.equal(errors.length, 5);
      assert.ok(errors.every(row => row.error === `HTTP 400: ${reason}`));
    });
  } finally { await f.close(); }
});
