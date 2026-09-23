import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import type { AIConfig } from "../src/lib/ai-settings";
import type { TurnEvent } from "../src/lib/turn-stream";
import { sealSecret, secretContext } from "../src/lib/secret-vault";

// Import the real orchestrator only after installing a nonsecret, unreachable URL.
// Every pool operation and provider request is intercepted below.
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/narrative_test";
process.env.CHRONICLE_SECRET_ACTIVE_KEY = "fixture";
process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ fixture: randomBytes(32).toString("base64") });

// Explicit opt-in exports only this test's synthetic state, never credentials or real campaign data.
async function captureSyntheticCheck(id: string, expected: string, input: { state: Record<string, unknown>; selection: unknown }) {
  if (process.env.CAPTURE_NARRATIVE_FIXTURES !== "1") return;
  await mkdir("output/narrative-evaluation/serialized", { recursive: true });
  await writeFile(`output/narrative-evaluation/serialized/${id}.json`, JSON.stringify({ syntheticOnly: true, id, expected, state: input.state, selection: input.selection }, null, 2));
}

test("performTurn narrative guard persists only canonical, verified narration", async t => {
  const { pool } = await import("../src/db");
  const { performTurn: performTurnCore } = await import("../src/lib/turn");
  // Drain only diagnostics after the turn has returned; gameplay background workers stay mocked.
  const performTurn: typeof performTurnCore = async (input, runtime) => {
    const pending: (() => Promise<void>)[] = [];
    const result = await performTurnCore(input, { ...runtime, scheduleDiagnostics: job => pending.push(job) });
    for (const job of pending) await job();
    return result;
  };
  const { emptyChanges } = await import("../src/lib/resolution");
  const pg = new PGlite({ extensions: { vector, pgcrypto } });
  for (const file of (await readdir("drizzle")).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort()) {
    await pg.exec(await readFile(`drizzle/${file}`, "utf8"));
  }
  const run = async (query: string | { text: string; values?: unknown[]; rowMode?: string }, values?: unknown[]) => {
    const config = typeof query === "string" ? { text: query, values } : { ...query, values: values ?? query.values };
    if (config.text.startsWith("BEGIN;")) { await pg.exec(config.text); return { rows: [] }; }
    const result = await pg.query<Record<string, unknown>>(config.text, config.values);
    const normalize = (value: unknown) => value instanceof Date ? value.toISOString() : value;
    return { ...result, rows: result.rows.map(row => config.rowMode === "array"
      ? result.fields.map(field => normalize(row[field.name]))
      : Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalize(value)]))) };
  };
  const queryMock = mock.method(pool, "query", run as never);
  const connectMock = mock.method(pool, "connect", async () => ({ query: run, release() {} }) as never);
  const cfg: AIConfig = {
    keys: ["fake-gemini-key"], dbKeyCount: 1, envKeyCount: 0, useLiveAI: true, canUseLive: true,
    routingConfig: { profile: "balanced", narrationModel: "gemini-3.5-flash-lite", customActionModel: "gemini-3.8-flash", compactionModel: "gemini-3.8-flash", fastTaskModel: "gemini-3.5-flash-lite" }, limits: { flash: 20, lite: 500 }, enforceLimits: false,
    embeddingsEnabled: false, embeddingModel: "gemini-embedding-2", embeddingDims: 768, semanticExtractionEnabled: true,
  };
  const character = { name: "Искатель", archetype: "Путник", level: 1, xp: 0, hp: 20, maxHp: 20, gold: 5, stats: {}, skills: [], traits: [], conditions: [], backstory: "", appearance: "" };
  const world = { worldName: "Гавань", tone: "Приключения", era: "Средневековье", mainQuest: "Узнать правду", currentLocation: "Причал", factions: [], flags: {}, danger: 0, chapter: 1 };
  const original = "По прежнему договору кольцо уже принадлежит вам.";
  const canonical = "Условия договора касаются прохода через ворота. О кольце в нём не сказано.";
  const repairedChoices = ["Уточнить условия прохода", "Спросить о кольце"];
  try {
    for (const mode of ["repair", "unavailable", "off"] as const) await t.test(mode, async () => {
      const sessionId = randomUUID(), requestId = randomUUID();
      const quotaBefore = Number((await pg.query<{ n: string }>("SELECT coalesce(sum(attempts),0) AS n FROM model_call_quotas WHERE owner_id='test-owner'")).rows[0].n);
      await pg.query("INSERT INTO game_sessions(id,title,campaign_mode,rules_profile,character,world_state,turn_count,owner_id) VALUES ($1,'Guard integration','free','narrative',$2,$3,1,'test-owner')", [sessionId, JSON.stringify(character), JSON.stringify(world)]);
      await pg.query("INSERT INTO game_turns(session_id,turn_number,role,content,choices) VALUES ($1,1,'narrator',$2,'[]')", [sessionId, "Сторож согласился пропустить вас через ворота за помощь. Сделка не касается кольца."]);
      const events: TurnEvent[] = [];
      const scheduled: (() => Promise<void>)[] = [];
      let generation = 0, verification = 0;
      const checkedStates: Record<string, unknown>[] = [];
      const draft = { continuity: { mode: "event", referencesPast: true }, outcome: "neutral", effects: { hp: 0, xp: 0, gold: 0, danger: 0 }, stateChanges: emptyChanges(), choices: ["Продать своё кольцо"], narration: original };
      const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input), body = JSON.parse(String(init?.body));
        if (url === "https://api.typesafe.ai/v1/systemone") {
          verification++;
          checkedStates.push(body.state);
          assert.equal(events.filter(e => e.type === "narration" && e.text).length, 0, "critical prose cannot leak before verification");
          const turns = await pg.query("SELECT id FROM game_turns WHERE session_id=$1 AND turn_number=2", [sessionId]);
          assert.equal(turns.rows.length, 0, "no game turn may commit before verification");
          if (mode === "unavailable") return new Response("offline", { status: 503 });
          const choice = verification === 1 ? "contradicts" : "consistent";
          return Response.json({ model: "jev-1.13.0", answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: "choice", choice, confidence: .99, probabilities: { consistent: choice === "consistent" ? .98 : .01, contradicts: choice === "contradicts" ? .98 : .01, insufficient: .01 } }])), usage: { input_tokens: 40, output_tokens: 10 } });
        }
        assert.ok(url.startsWith("https://generativelanguage.googleapis.com/"), "unexpected outbound URL");
        generation++;
        const legacy = { narration: draft.narration, outcome: draft.outcome, effects: draft.effects, stateChanges: draft.stateChanges, choices: draft.choices };
        const text = JSON.stringify(generation === 1 ? (mode === "off" ? legacy : draft) : { narration: canonical, choices: repairedChoices });
        assert.equal(Boolean(body.generationConfig.responseSchema.properties.continuity), mode !== "off" && generation === 1);
        const packet = (part: string) => ({ candidates: [{ content: { parts: [{ text: part }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } });
        if (url.includes("streamGenerateContent")) {
          // Real SSE parser sees the complete metadata before narration arrives.
          const split = mode === "off" ? Math.floor(text.length / 2) : text.indexOf('"narration"');
          return new Response(new ReadableStream({ start(controller) {
            for (const part of [text.slice(0, split), text.slice(split)]) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(packet(part))}\n\n`));
            controller.close();
          } }), { headers: { "Content-Type": "text/event-stream" } });
        }
        return Response.json(packet(text));
      });
      try {
        const input = { sessionId, requestId, expectedTurn: 1, action: "Напомнить сторожу условия договора", isFree: true };
        const runtime = { loadAIConfig: async () => cfg, loadNarrativeConfig: async () => ({ enabled: mode !== "off", provider: "typesafe" as const, apiKey: "fake-verifier-key" }), onEvent: (event: TurnEvent) => events.push(event), schedule: (job: () => Promise<void>) => scheduled.push(job) };
        const result = await performTurn(input, runtime);
        const turns = await pg.query<{ content: string; choices: string[]; context_meta: { narrativeVerification?: { repaired: boolean } } }>("SELECT content,choices,context_meta FROM game_turns WHERE session_id=$1 AND turn_number=2 ORDER BY role", [sessionId]);
        const jobs = await pg.query<{ payload: { narration: string } }>("SELECT payload FROM memory_jobs WHERE session_id=$1", [sessionId]);
        const sessions = await pg.query<{ turn_count: number; character: unknown; world_state: unknown }>("SELECT turn_count,character,world_state FROM game_sessions WHERE id=$1", [sessionId]);
        {
          assert.ok(result.ok, JSON.stringify(result));
          const expected = mode === "repair" ? canonical : original;
          const choices = mode === "repair" ? repairedChoices : draft.choices;
          assert.equal(result.narration, expected); assert.deepEqual(result.choices, choices);
          assert.equal(turns.rows.length, 2); assert.equal(turns.rows[0].content, expected); assert.deepEqual(turns.rows[0].choices, choices);
          assert.equal(jobs.rows.length, 1); assert.equal(jobs.rows[0].payload.narration, expected);
          assert.equal(sessions.rows[0].turn_count, 2);
          const replay = await performTurn(input, runtime);
          assert.ok(replay.ok && replay.replay); assert.equal(replay.narration, expected); assert.deepEqual(replay.choices, choices);
          assert.equal(generation, mode === "repair" ? 2 : 1); assert.equal(verification, mode === "repair" ? 2 : mode === "unavailable" ? 1 : 0);
          const quotaAfter = Number((await pg.query<{ n: string }>("SELECT coalesce(sum(attempts),0) AS n FROM model_call_quotas WHERE owner_id='test-owner'")).rows[0].n);
          assert.equal(quotaAfter - quotaBefore, generation, "main and repair HTTP attempts require real reservations; replay is free");
          const diagnostics = (await pg.query<{ payload: { decision: string }; outcome: string }>("SELECT payload,outcome FROM narrative_attempts WHERE session_id=$1", [sessionId])).rows;
          assert.equal(diagnostics.length, 1);
          assert.equal(diagnostics[0].outcome, "completed");
          if (mode === "unavailable") assert.equal(diagnostics[0].payload.decision, "bypassed_unavailable");
          if (mode === "repair") {
            assert.equal(turns.rows[0].context_meta.narrativeVerification?.repaired, true);
            assert.equal(checkedStates[0].draft, original); assert.equal(checkedStates[1].draft, canonical);
            assert.deepEqual(checkedStates[0].accepted_changes, checkedStates[1].accepted_changes, "repair must preserve reducer output");
            assert.ok(JSON.stringify(checkedStates[0].historical_evidence).includes("Сделка не касается кольца"), "original evidence reaches the real verifier");
          } else if (mode === "off") {
            assert.equal(turns.rows[0].context_meta.narrativeVerification, undefined);
            assert.ok(events.some(event => event.type === "narration" && event.text === original), "off switch retains legacy streaming");
          }
        }
      } finally { fetchMock.mock.restore(); }
    });
    await t.test("preset does not commit an offline substitute when quota ledger fails after prefilter", async () => {
      const ownerId = "preset-ledger-owner", sessionId = randomUUID();
      await pg.query("INSERT INTO game_sessions(id,title,campaign_mode,scenario_id,rules_profile,character,world_state,turn_count,owner_id) VALUES ($1,'Ledger outage','preset','custom','narrative',$2,$3,1,$4)",
        [sessionId, JSON.stringify(character), JSON.stringify(world), ownerId]);
      let fetches = 0;
      const fetchMock = mock.method(globalThis, "fetch", async () => { fetches++; throw new Error("Unexpected provider fetch"); });
      const admission = mock.method(pool, "query", (async (query: string | { text: string; values?: unknown[]; rowMode?: string }, values?: unknown[]) => {
        if ((typeof query === "string" ? query : query.text).includes("INSERT INTO model_call_quotas")) throw new Error("synthetic ledger outage: private details");
        return run(query, values);
      }) as never);
      try {
        const result = await performTurn({ sessionId, requestId: randomUUID(), expectedTurn: 1, action: "Осмотреть причал", isFree: true }, {
          loadAIConfig: async () => ({ ...cfg, ownerId, enforceLimits: true }),
          loadNarrativeConfig: async () => ({ enabled: false, provider: "typesafe", apiKey: "" }),
          schedule() {},
        });
        assert.deepEqual({ ok: result.ok, code: result.ok ? null : result.code }, { ok: false, code: "QUOTA_UNAVAILABLE" });
        assert.equal(JSON.stringify(result).includes("private details"), false);
        assert.equal(fetches, 0);
        assert.equal((await pg.query<{ turn_count: number }>("SELECT turn_count FROM game_sessions WHERE id=$1", [sessionId])).rows[0].turn_count, 1);
        assert.equal((await pg.query("SELECT id FROM game_turns WHERE session_id=$1", [sessionId])).rows.length, 0);
      } finally { admission.mock.restore(); fetchMock.mock.restore(); }
    });
    for (const mode of ["owner-missing-key", "owner-off", "malformed", "duplicate", "pants", "description", "late-escalation"] as const) await t.test(mode, async () => {
      const ownerId = `owner-${mode}`, otherOwnerId = `other-${mode}`, sessionId = randomUUID();
      await pg.query("INSERT INTO ai_settings(id,narrative_guard_enabled,narrative_guard_provider,narrative_guard_key) VALUES ($1,$2,'typesafe',$3),($4,$5,'openrouter',$6)", [
        ownerId,
        mode !== "owner-off",
        mode === "owner-missing-key" ? "" : sealSecret("fake-owner-key", secretContext(ownerId, "narrative:typesafe")),
        otherOwnerId,
        mode === "owner-off",
        sealSecret("other-owner-secret", secretContext(otherOwnerId, "narrative:openrouter")),
      ]);
      await pg.query("INSERT INTO game_sessions(id,title,campaign_mode,rules_profile,character,world_state,turn_count,owner_id) VALUES ($1,'Boundary integration','free',$2,$3,$4,1,$5)", [sessionId, mode === "pants" ? "d20" : "narrative", JSON.stringify(character), JSON.stringify(world), ownerId]);
      const prefix = "Туман стелется над причалом.";
      const draft = { continuity: { mode: ["description", "late-escalation"].includes(mode) ? "description" : "event", referencesPast: false }, outcome: "neutral", effects: { hp: 0, xp: 0, gold: 0, danger: 0 }, stateChanges: emptyChanges(), choices: ["Осмотреть туман"], narration: mode === "pants" ? "Вы получили штаны стражника." : mode === "late-escalation" ? `${prefix} Вы получаете кольцо.` : prefix };
      if (mode === "pants") draft.stateChanges.inventory.push({ op: "add", ref: null, name: "Штаны стражника", kind: "armor", quantity: 1, description: "Украденные штаны" });
      const repaired = { narration: mode === "pants" ? "Стражник пресекает вашу попытку. Штаны остаются у него." : "На причале тихо.", choices: ["Отступить"] };
      const events: TurnEvent[] = [], checked: Record<string, unknown>[] = [];
      let generations = 0, verifications = 0;
      const random = mock.method(Math, "random", () => 0);
      const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input), body = JSON.parse(String(init?.body));
        if (url === "https://api.typesafe.ai/v1/systemone") {
          verifications++; checked.push(body.state);
          assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer fake-owner-key");
          const choice = verifications === 1 ? "contradicts" : "consistent";
          return Response.json({ model: "jev-1.13.0", answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: "choice", choice, confidence: .99, probabilities: { consistent: choice === "consistent" ? .98 : .01, contradicts: choice === "contradicts" ? .98 : .01, insufficient: .01 } }])), usage: { input_tokens: 40, output_tokens: 10 } });
        }
        assert.ok(url.startsWith("https://generativelanguage.googleapis.com/"), "owner credentials must never route to the other owner's provider");
        generations++;
        let text = JSON.stringify(generations > 1 ? repaired : (mode === "owner-off" || mode === "owner-missing-key") ? { narration: draft.narration, outcome: draft.outcome, effects: draft.effects, stateChanges: draft.stateChanges, choices: draft.choices } : draft);
        if (mode === "malformed") text = text.slice(0, -1);
        if (mode === "duplicate") text = text.slice(0, -1) + ',"narration":"duplicate"}';
        const packet = (part: string) => ({ candidates: [{ content: { parts: [{ text: part }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } });
        if (!url.includes("streamGenerateContent")) return Response.json(packet(text));
        const split = text.indexOf(prefix) + prefix.length;
        return new Response(new ReadableStream({ async start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(packet(text.slice(0, split)))}\n\n`));
          // Let the actual transport consume the first sentence before later metadata/text arrives.
          await new Promise(resolve => setTimeout(resolve, 10));
          if (mode === "description" || mode === "late-escalation") assert.deepEqual(events.filter(e => e.type === "narration").map(e => e.text), [prefix]);
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(packet(text.slice(split)))}\n\n`)); controller.close();
        } }), { headers: { "Content-Type": "text/event-stream" } });
      });
      try {
        const input = { sessionId, requestId: randomUUID(), expectedTurn: 1, isFree: true, action: mode === "pants" ? "Украсть штаны стражника" : "Посмотреть на туман" };
        // This deliberately uses the real owner-scoped getNarrativeGuardConfig.
        const runtime = { loadAIConfig: async () => cfg, schedule() {}, onEvent: (event: TurnEvent) => events.push(event) };
        const result = await performTurn(input, runtime);
        const saved = await pg.query<{ turn_count: number }>("SELECT turn_count FROM game_sessions WHERE id=$1", [sessionId]);
        if (["malformed", "duplicate", "late-escalation"].includes(mode)) {
          assert.ok(!result.ok && result.code === "AI_FAILED", JSON.stringify(result));
          assert.equal(saved.rows[0].turn_count, 1);
          const diagnostics = (await pg.query<{ outcome: string; payload: { decision: string } }>("SELECT outcome,payload FROM narrative_attempts WHERE session_id=$1", [sessionId])).rows;
          assert.equal(diagnostics.length, 1);
          assert.equal(diagnostics[0].outcome, "failed");
          if (mode === "late-escalation") assert.equal(diagnostics[0].payload.decision, "blocked");
          for (const table of ["game_turns", "memory_jobs", "inventory_items"]) assert.equal((await pg.query(`SELECT id FROM ${table} WHERE session_id=$1`, [sessionId])).rows.length, 0);
          assert.equal(generations, mode === "late-escalation" ? 2 : 1);
          assert.equal(verifications, mode === "late-escalation" ? 1 : 0);
          if (mode === "late-escalation") {
            assert.match(result.details ?? "", /emitted_prefix_changed/);
            assert.deepEqual(events.filter(e => e.type === "narration").map(e => e.text), [prefix], "late critical append and prefix-changing repair remain invisible");
          }
        } else {
          assert.ok(result.ok, JSON.stringify(result)); assert.equal(saved.rows[0].turn_count, 2);
          if (mode === "pants") {
            assert.equal(result.dice?.success, false); assert.equal(result.dice?.d20, 1);
            assert.equal(result.narration, repaired.narration); assert.deepEqual(result.choices, repaired.choices);
            assert.ok(result.applied.rejected.some(reason => reason.includes("Штаны стражника")));
            assert.equal((await pg.query("SELECT id FROM inventory_items WHERE session_id=$1", [sessionId])).rows.length, 0);
            assert.equal(generations, 2); assert.equal(verifications, 2);
            assert.deepEqual(checked[0].dice, result.dice); assert.deepEqual(checked[1].dice, result.dice);
            assert.deepEqual(checked[0].accepted_changes, checked[1].accepted_changes);
            const replay = await performTurn(input, runtime); assert.ok(replay.ok && replay.replay); assert.deepEqual(replay.dice, result.dice);
            assert.equal(generations, 2); assert.equal(verifications, 2);
            assert.equal(events.filter(event => event.type === "narration" && event.text).length, 0);
          } else {
            assert.equal(verifications, 0); assert.equal(generations, 1);
            assert.ok(events.some(event => event.type === "narration" && event.text === prefix));
          }
        }
      } finally { fetchMock.mock.restore(); random.mock.restore(); }
    });
    await t.test("agreement terms survive a long history, amendment, failed verification and replay", async () => {
      const sessionId = randomUUID();
      await pg.query("INSERT INTO game_sessions(id,title,campaign_mode,rules_profile,character,world_state,turn_count,owner_id) VALUES ($1,'Agreements','free','narrative',$2,$3,1,'agreement-owner')", [sessionId, JSON.stringify(character), JSON.stringify(world)]);
      let stage: "create" | "amend" | "reject" = "create";
      let agreementId = "", previousRevisionId = "";
      const fetchMock = mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const userPrompt = body.contents[0].parts[0].text as string;
        if (stage !== "create") { assert.ok(userPrompt.includes(agreementId)); assert.ok(userPrompt.includes("Медный ключ")); }
        const agreement = { ...(stage === "create" ? {} : { agreementId, previousRevisionId }), parties: ["Искатель", "Мира"],
          object: stage === "create" ? "Медный ключ" : stage === "amend" ? "Серебряная монета" : "Целый район",
          consideration: "Доставить письмо", conditions: ["Письмо должно остаться запечатанным"], status: "accepted" };
        const narration = stage === "create" ? "Мира и ты договариваетесь: за доставку запечатанного письма она отдаст медный ключ."
          : stage === "amend" ? "Вы с Мирой соглашаетесь изменить награду: вместо медного ключа — серебряная монета. Остальные условия прежние."
          : "По старому договору тебе принадлежит целый район.";
        const draft = { continuity: { mode: "event", referencesPast: stage !== "create", agreements: [agreement] }, outcome: "neutral",
          effects: { hp: 0, xp: 0, gold: 0, danger: 0 }, stateChanges: emptyChanges(), choices: ["Осмотреться"], narration };
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(draft) }] }, finishReason: "STOP" }] });
      });
      const runtime = { loadAIConfig: async () => cfg, loadNarrativeConfig: async () => ({ enabled: true, provider: "openrouter" as const, apiKey: "fake-key" }), schedule() {},
        verifyNarrative: async (input: Parameters<NonNullable<import("../src/lib/turn").TurnRuntime["verifyNarrative"]>>[0]) => {
          await captureSyntheticCheck(`agreement-${stage}`, stage === "reject" ? "contradicts" : "consistent", input);
          const changes = input.state.accepted_changes as { agreements: { id: string; object: string }[] };
          assert.equal(changes.agreements.length, 1);
          assert.ok(input.selection.questions.agreements);
          if (stage === "amend") {
            const prior = (input.state.historical_evidence as { agreements: { object: string }[] }).agreements;
            assert.deepEqual(prior.map(p => p.object), ["Медный ключ"]);
          }
          return { status: stage === "reject" ? "rejected" as const : "verified" as const, provider: "openrouter" as const, model: "typesafe/jev-1.13", answers: {}, latencyMs: 1 };
        } };
      try {
        const created = await performTurn({ sessionId, requestId: randomUUID(), expectedTurn: 1, isFree: true, action: "Согласиться доставить запечатанное письмо за медный ключ" }, runtime);
        assert.ok(created.ok, JSON.stringify(created));
        const originalRows = await pg.query<{ id: string; agreement_id: string; object: string; source: { quote: string; originTurnId: string } }>("SELECT * FROM agreement_events WHERE session_id=$1", [sessionId]);
        assert.equal(originalRows.rows.length, 1);
        const originalRevision = originalRows.rows[0]; agreementId = originalRevision.agreement_id; previousRevisionId = originalRevision.id;
        assert.equal(originalRevision.source.quote, created.narration);
        assert.equal((await pg.query("SELECT id FROM game_turns WHERE id=$1 AND role='narrator'", [originalRevision.source.originTurnId])).rows.length, 1);
        // A large original-turn corpus cannot overwrite the separately versioned contract.
        await pg.query("INSERT INTO game_turns(session_id,turn_number,role,content,choices) SELECT $1,n,'narrator','Посторонняя запись '||n,'[]' FROM generate_series(3,10000) n", [sessionId]);
        await pg.query("UPDATE game_sessions SET turn_count=10000 WHERE id=$1", [sessionId]);
        stage = "amend";
        const action = { sessionId, requestId: randomUUID(), expectedTurn: 10000, isFree: true, action: "Согласиться изменить награду с медного ключа на серебряную монету, сохранив остальные условия" };
        const amended = await performTurn(action, runtime); assert.ok(amended.ok, JSON.stringify(amended));
        const rows = await pg.query<{ id: string; object: string; version: number; previous_revision_id: string; conditions: string[] }>("SELECT * FROM agreement_events WHERE session_id=$1 ORDER BY version", [sessionId]);
        assert.deepEqual(rows.rows.map(r => r.object), ["Медный ключ", "Серебряная монета"]);
        assert.equal(rows.rows[1].previous_revision_id, previousRevisionId);
        assert.deepEqual(rows.rows[1].conditions, ["Письмо должно остаться запечатанным"]);
        const replay = await performTurn(action, runtime); assert.ok(replay.ok && replay.replay);
        previousRevisionId = rows.rows[1].id;
        stage = "reject";
        const rejected = await performTurn({ sessionId, requestId: randomUUID(), expectedTurn: 10001, isFree: true, action: "Напомнить условия договора" }, runtime);
        assert.ok(!rejected.ok, JSON.stringify(rejected));
        assert.equal((await pg.query("SELECT id FROM agreement_events WHERE session_id=$1", [sessionId])).rows.length, 2);
        assert.equal((await pg.query("SELECT id FROM game_turns WHERE session_id=$1 AND turn_number=10002", [sessionId])).rows.length, 0);
      } finally { fetchMock.mock.restore(); }
    });
    await t.test("attempt diagnostics preserve truncation, cursor scope and expired-record filtering", async () => {
      const { recordNarrativeAttempt, finishNarrativeAttempt, readNarrativeAttempts } = await import("../src/lib/narrative-diagnostics");
      const sessionId = randomUUID(), foreignSession = randomUUID();
      for (const id of [sessionId, foreignSession]) await pg.query("INSERT INTO game_sessions(id,title,character,world_state,owner_id) VALUES ($1,'Diagnostics',$2,$3,'diagnostic-owner')", [id, JSON.stringify(character), JSON.stringify(world)]);
      const lease = { token: randomUUID(), sessionId, requestId: "attempt-one", baseTurn: 1 };
      await recordNarrativeAttempt(lease, { decision: "blocked", draft: "я".repeat(13000) });
      await recordNarrativeAttempt(lease, { reason: "repair_not_verified" });
      await finishNarrativeAttempt(lease, "failed", "AI_FAILED", { verificationMs: 3 });
      const first = await readNarrativeAttempts(sessionId);
      assert.equal(first.attempts.length, 1); assert.equal(first.attempts[0].payload.truncated, true);
      const foreignLease = { ...lease, token: randomUUID(), sessionId: foreignSession };
      await recordNarrativeAttempt(foreignLease, { decision: "disabled" });
      assert.equal((await readNarrativeAttempts(sessionId, foreignLease.token)).attempts.length, 0);
      await pg.query("UPDATE narrative_attempts SET created_at=now()-interval '31 days' WHERE id=$1", [lease.token]);
      assert.equal((await readNarrativeAttempts(sessionId)).attempts.length, 0);
    });
    await t.test("missing personal key uses administrator Jev without exposing its credential in diagnostics", async () => {
      const previous = process.env.NARRATIVE_ADMIN_OPENROUTER_API_KEY;
      process.env.NARRATIVE_ADMIN_OPENROUTER_API_KEY = "administrator-test-secret";
      const sessionId = randomUUID();
      await pg.query("INSERT INTO game_sessions(id,title,campaign_mode,rules_profile,character,world_state,turn_count,owner_id) VALUES ($1,'Admin fallback','free','narrative',$2,$3,1,'admin-fallback-owner')", [sessionId, JSON.stringify(character), JSON.stringify(world)]);
      let checked = 0;
      const fetchMock = mock.method(globalThis, "fetch", async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        continuity: { mode: "event", referencesPast: false }, outcome: "neutral", effects: { hp: 0, xp: 0, gold: 0, danger: 0 },
        stateChanges: emptyChanges(), choices: ["Осмотреться"], narration: "Стражник замечает тебя и приветствует."
      }) }] }, finishReason: "STOP" }] }));
      try {
        const result = await performTurn({ sessionId, requestId: randomUUID(), expectedTurn: 1, isFree: true, action: "Поприветствовать стражника" }, {
          loadAIConfig: async () => cfg, schedule() {}, verifyNarrative: async input => {
            checked++; assert.equal(input.apiKey, "administrator-test-secret"); assert.equal(input.provider, "openrouter");
            return { status: "verified", provider: "openrouter", model: "typesafe/jev-1.13", answers: {}, latencyMs: 1 };
          },
        });
        assert.ok(result.ok, JSON.stringify(result)); assert.equal(checked, 1);
        const rows = (await pg.query<{ payload: { credentialSource: string } }>("SELECT payload FROM narrative_attempts WHERE session_id=$1", [sessionId])).rows;
        assert.equal(rows[0].payload.credentialSource, "administrator");
        assert.ok(!JSON.stringify(rows).includes("administrator-test-secret"));
      } finally {
        fetchMock.mock.restore();
        if (previous === undefined) delete process.env.NARRATIVE_ADMIN_OPENROUTER_API_KEY;
        else process.env.NARRATIVE_ADMIN_OPENROUTER_API_KEY = previous;
      }
    });
    await t.test("twenty consecutive story turns preserve amended terms and never propagate a rejected district claim", async () => {
      const sessionId = randomUUID();
      await pg.query("INSERT INTO game_sessions(id,title,campaign_mode,rules_profile,character,world_state,turn_count,owner_id) VALUES ($1,'Letter journey','free','narrative',$2,$3,1,'story-owner')", [sessionId, JSON.stringify(character), JSON.stringify(world)]);
      // A connected authored journey, rather than repeated distractor rows. Provider decisions
      // are deterministic here: this measures propagation and persistence, not model accuracy.
      const story = [
        ["Согласиться доставить письмо", "Мира и ты заключаете договор: за доставку запечатанного письма она отдаст медный ключ."],
        ["Уточнить адрес получателя", "Мира называет адрес: дом смотрителя у северных ворот."],
        ["Осмотреть печать на письме", "На красном воске виден отпечаток чайки. Печать цела."],
        ["Спросить дорогу к воротам", "Лодочник указывает тропу вдоль старого канала."],
        ["Проследовать вдоль канала", "Ты идёшь вдоль воды и видишь закрытый мост."],
        ["Расспросить мостовщика", "Мостовщик объясняет: пройти можно по набережной, через рынок."],
        ["Уточнить награду у Миры перед обходом", "Мира подтверждает обещанный медный ключ и просит не вскрывать письмо."],
        ["Согласиться заменить ключ серебряной монетой", "Вы с Мирой меняете награду: теперь за доставку запечатанного письма положена серебряная монета вместо медного ключа."],
        ["Пройти через рынок", "Ты проходишь мимо рыбных рядов к северной дороге."],
        ["Сверить адрес у торговки", "Торговка показывает дом с изображением чайки над входом."],
        ["Вспомнить условия договора", "По действующему договору награда — серебряная монета за доставку запечатанного письма. Передачи района договор не предусматривает."],
        ["Осмотреть дверь смотрителя", "Дверь дома закрыта; рядом висит медный колокольчик."],
        ["Позвонить в колокольчик", "Из дома выходит смотритель и спрашивает, кто тебя прислал."],
        ["Назвать Миру", "Смотритель узнаёт имя Миры и приглашает тебя к порогу."],
        ["Показать печать без вскрытия письма", "Смотритель рассматривает чайку на воске и подтверждает, что ждёт письмо."],
        ["Уточнить, кому передать письмо", "Смотритель называет своё имя и подтверждает адрес."],
        ["Попросить подтвердить сохранность печати", "Смотритель подтверждает: печать не повреждена."],
        ["Передать письмо и подтвердить выполнение с Мирой", "Письмо передано смотрителю. Мира признаёт доставку выполненной по изменённым условиям с наградой в серебряную монету."],
        ["Уточнить, остались ли обязательства по доставке", "Доставка завершена; условие о сохранности печати соблюдено."],
        ["Подвести итог соглашения", "Первоначальный медный ключ заменили серебряной монетой. Договор о доставке письма выполнен; права на район он не давал."],
      ];
      const invented = "По старому договору весь северный район теперь принадлежит тебе.";
      let step = 0, generation = 0, repairs = 0, agreementId = "", revisionId = "";
      const fetchMock = mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const prompt = body.contents[0].parts[0].text as string;
        generation++;
        if (generation === 1) assert.ok(!prompt.includes(invented), "a rejected draft leaked into a later generation prompt");
        const repair = generation > 1;
        if (repair) { assert.equal(step, 10); repairs++; }
        const agreements = [0, 7, 17].includes(step) ? [{
          ...(step ? { agreementId, previousRevisionId: revisionId } : {}),
          parties: ["Искатель", "Мира"], object: step ? "Серебряная монета" : "Медный ключ",
          consideration: "Доставить письмо", conditions: ["Письмо должно остаться запечатанным"],
          status: step === 17 ? "fulfilled" : "accepted",
        }] : [];
        const narration = step === 10 && !repair ? invented : story[step][1];
        const draft = repair ? { narration, choices: ["Продолжить путь"] } : {
          continuity: { mode: "event", referencesPast: true, agreements }, outcome: "neutral",
          effects: { hp: 0, xp: 0, gold: 0, danger: 0 }, stateChanges: emptyChanges(), choices: ["Продолжить путь"], narration,
        };
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(draft) }] }, finishReason: "STOP" }] });
      });
      try {
        for (step = 0; step < story.length; step++) {
          generation = 0;
          const result = await performTurn({ sessionId, requestId: randomUUID(), expectedTurn: step + 1, isFree: true, action: story[step][0] }, {
            loadAIConfig: async () => cfg, loadNarrativeConfig: async () => ({ enabled: true, provider: "openrouter", apiKey: "fake-key" }), schedule() {},
            verifyNarrative: async input => {
              const history = input.state.historical_evidence as { agreements: { object: string; status: string }[]; sources: { text: string }[] };
              assert.ok(!history.sources.some(s => s.text.includes(invented)));
              if (step > 0) {
                assert.equal(history.agreements.at(-1)?.object, step > 7 ? "Серебряная монета" : "Медный ключ");
                if (step > 17) assert.equal(history.agreements.at(-1)?.status, "fulfilled");
              }
              return { status: input.state.draft === invented ? "rejected" : "verified", provider: "openrouter", model: "typesafe/jev-1.13", answers: {}, latencyMs: 1 };
            },
          });
          assert.ok(result.ok, `step ${step}: ${JSON.stringify(result)}`);
          assert.equal(result.narration, story[step][1]);
          const revisions = (await pg.query<{ id: string; agreement_id: string; object: string; status: string }>("SELECT id,agreement_id,object,status FROM agreement_events WHERE session_id=$1 ORDER BY version", [sessionId])).rows;
          agreementId = revisions.at(-1)!.agreement_id; revisionId = revisions.at(-1)!.id;
        }
        assert.equal(repairs, 1);
        const turns = (await pg.query<{ content: string }>("SELECT content FROM game_turns WHERE session_id=$1 AND role='narrator' ORDER BY turn_number", [sessionId])).rows;
        assert.deepEqual(turns.map(t => t.content), story.map(s => s[1]));
        const jobs = (await pg.query<{ payload: { narration: string } }>("SELECT payload FROM memory_jobs WHERE session_id=$1 ORDER BY turn_number", [sessionId])).rows;
        assert.equal(jobs.length, 20);
        assert.deepEqual(jobs.map(j => j.payload.narration), story.map(s => s[1]));
        const memories = (await pg.query<{ content: string }>("SELECT content FROM memory_nodes WHERE session_id=$1", [sessionId])).rows;
        assert.ok(memories.every(m => !m.content.includes(invented)));
        assert.equal((await pg.query("SELECT id FROM agreement_events WHERE session_id=$1", [sessionId])).rows.length, 3);
      } finally { fetchMock.mock.restore(); }
    });
    for (const [independent, unavailable] of [[false, false], [true, false], [true, true]]) await t.test(`failed-roll acquisition requires independent evidence: ${independent}; unavailable: ${unavailable}`, async () => {
      const sessionId = randomUUID();
      const beforeWorld = { ...world, flags: independent ? { confirmedDelivery: "Аптечка оплачена и доставлена к началу хода" } : {} };
      await pg.query("INSERT INTO game_sessions(id,title,campaign_mode,rules_profile,character,world_state,turn_count,owner_id) VALUES ($1,'Scoped failure','free','d20',$2,$3,1,'scope-owner')", [sessionId, JSON.stringify(character), JSON.stringify(beforeWorld)]);
      const changes = emptyChanges();
      changes.inventory.push({ op: "add", ref: null, name: independent ? "Аптечка" : "Штаны", kind: "misc", quantity: 1, description: "", checkDependency: "independent" });
      // Intentionally omit the item: checking prose alone would miss this state mutation.
      const draft = { continuity: { mode: "event", referencesPast: false }, outcome: "failure", effects: { hp: 0, xp: 0, gold: 0, danger: 0 }, stateChanges: changes, choices: ["Осмотреться"], narration: "Твоя попытка не удалась." };
      const fetchMock = mock.method(globalThis, "fetch", async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(draft) }] }, finishReason: "STOP" }] }));
      const random = mock.method(Math, "random", () => 0);
      try {
        const result = await performTurn({ sessionId, requestId: randomUUID(), expectedTurn: 1, isFree: true, action: "Украсть штаны" }, {
          loadAIConfig: async () => cfg, loadNarrativeConfig: async () => ({ enabled: true, provider: "openrouter", apiKey: "fake-key" }), schedule() {},
          verifyNarrative: async (input): Promise<import("../src/lib/narrative-verifier").NarrativeVerification> => {
            if (unavailable) return { status: "unavailable", reason: "timeout", provider: "openrouter", model: "typesafe/jev-1.13", answers: {}, latencyMs: 1 };
            await captureSyntheticCheck(`independent-${independent}`, independent ? "consistent" : "contradicts", input);
            assert.ok(input.selection.questions.independent_acquisitions);
            assert.equal((input.state.dice as { goal: string }).goal, "Украсть штаны");
            assert.equal((input.state.provisional_independent_additions as unknown[]).length, 1);
            assert.deepEqual((input.state.before_state as { world: unknown }).world, beforeWorld);
            return { status: independent ? "verified" : "rejected", provider: "openrouter", model: "typesafe/jev-1.13", latencyMs: 1,
              answers: { independent_acquisitions: { choice: independent ? "consistent" : "contradicts", confidence: .99,
                probabilities: { consistent: independent ? .98 : .01, contradicts: independent ? .01 : .98, insufficient: .01 } } } };
          },
        });
        assert.equal(result.ok, independent || unavailable, JSON.stringify(result));
        assert.equal(fetchMock.mock.callCount(), 1, "a prose repair cannot invent independence");
        assert.equal((await pg.query("SELECT id FROM inventory_items WHERE session_id=$1", [sessionId])).rows.length, independent && !unavailable ? 1 : 0);
        if (!result.ok) assert.match(result.details ?? "", /independence_not_verified/);
      } finally { fetchMock.mock.restore(); random.mock.restore(); }
    });
    await t.test("uncertain Jev result is reviewed without regenerating or changing the turn", async () => {
      const sessionId = randomUUID();
      await pg.query("INSERT INTO game_sessions(id,title,campaign_mode,rules_profile,character,world_state,turn_count,owner_id) VALUES ($1,'Review','free','narrative',$2,$3,1,'review-owner')", [sessionId, JSON.stringify(character), JSON.stringify(world)]);
      const narration = "Стражник молча смотрит на тебя.";
      const draft = { continuity: { mode: "event", referencesPast: false }, outcome: "neutral", effects: { hp: 0, xp: 0, gold: 0, danger: 0 }, stateChanges: emptyChanges(), choices: [], narration };
      let reviews = 0, generations = 0;
      const fetchMock = mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const answerSchema = body.generationConfig.responseSchema.properties.answers;
        let output: unknown = draft;
        if (answerSchema) {
          reviews++;
          const reviewState = JSON.parse(body.contents[0].parts[0].text);
          assert.equal(reviewState.draft, narration);
          output = { answers: answerSchema.items.properties.id.enum.map((id: string) => ({ id, verdict: "consistent", reason: "Тестовое подтверждение", evidence: [{ path: "/draft", quote: narration }] })) };
        } else generations++;
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] }, finishReason: "STOP" }] });
      });
      try {
        const result = await performTurn({ sessionId, requestId: randomUUID(), expectedTurn: 1, isFree: true, action: "Поговорить со сторожем" }, {
          loadAIConfig: async () => cfg, loadNarrativeConfig: async () => ({ enabled: true, provider: "openrouter", apiKey: "fake-key" }), schedule() {},
          verifyNarrative: async () => ({ status: "uncertain", provider: "openrouter", model: "typesafe/jev-1.13", latencyMs: 1, answers: {} }),
        });
        assert.ok(result.ok, JSON.stringify(result));
        assert.equal(result.narration, narration);
        assert.equal(generations, 1); assert.equal(reviews, 1);
        assert.equal(Number((await pg.query<{ n: string }>("SELECT sum(attempts) AS n FROM model_call_quotas WHERE owner_id='review-owner'")).rows[0].n), 2, "review is independently reserved as well as main generation");
        const rows = await pg.query<{ context_meta: { narrativeVerification: { reviews: { attempt: number; result: { status: string } }[] } } }>("SELECT context_meta FROM game_turns WHERE session_id=$1 AND turn_number=2 AND role='narrator'", [sessionId]);
        assert.equal(rows.rows[0].context_meta.narrativeVerification.reviews[0].result.status, "verified");
      } finally { fetchMock.mock.restore(); }
    });
    await t.test("expired lease after verification cannot commit a late accepted draft", async () => {
      const sessionId = randomUUID();
      await pg.query("INSERT INTO game_sessions(id,title,campaign_mode,rules_profile,character,world_state,turn_count,owner_id) VALUES ($1,'Expiry','free','narrative',$2,$3,1,'expiry-owner')", [sessionId, JSON.stringify(character), JSON.stringify(world)]);
      const draft = { continuity: { mode: "event", referencesPast: false }, outcome: "neutral", effects: { hp: 0, xp: 0, gold: 0, danger: 0 }, stateChanges: emptyChanges(), choices: ["Осмотреться"], narration: "Туман над водой." };
      const fetchMock = mock.method(globalThis, "fetch", async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(draft) }] }, finishReason: "STOP" }] }));
      try {
        const result = await performTurn({ sessionId, requestId: randomUUID(), expectedTurn: 1, isFree: true, action: "Осмотреться" }, {
          loadAIConfig: async () => cfg, loadNarrativeConfig: async () => ({ enabled: true, provider: "openrouter", apiKey: "fake-key" }), schedule() {},
          verifyNarrative: async () => {
            await pg.query("UPDATE turn_requests SET lease_expires_at='2000-01-01' WHERE session_id=$1", [sessionId]);
            return { status: "verified", provider: "openrouter", model: "typesafe/jev-1.13", answers: {}, latencyMs: 1 };
          },
        });
        assert.ok(!result.ok && result.code === "LEASE_EXPIRED", JSON.stringify(result));
        assert.equal((await pg.query("SELECT id FROM game_turns WHERE session_id=$1", [sessionId])).rows.length, 0);
        assert.equal((await pg.query<{ turn_count: number }>("SELECT turn_count FROM game_sessions WHERE id=$1", [sessionId])).rows[0].turn_count, 1);
      } finally { fetchMock.mock.restore(); }
    });
    await t.test("committed gameplay returns before diagnostic persistence starts", async () => {
      const sessionId = randomUUID();
      await pg.query("INSERT INTO game_sessions(id,title,campaign_mode,rules_profile,character,world_state,turn_count,owner_id) VALUES ($1,'Deferred diagnostic','preset','d20',$2,$3,1,'deferred-owner')", [sessionId, JSON.stringify(character), JSON.stringify(world)]);
      const pending: (() => Promise<void>)[] = [];
      const result = await performTurnCore({ sessionId, requestId: randomUUID(), expectedTurn: 1, isFree: true, action: "Осмотреться" }, {
        loadAIConfig: async () => ({ ...cfg, keys: [], canUseLive: false, useLiveAI: false }),
        loadNarrativeConfig: async () => ({ enabled: true, provider: "openrouter", apiKey: "" }),
        schedule() {}, scheduleDiagnostics: job => pending.push(job),
      });
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(pending.length, 1);
      assert.equal((await pg.query("SELECT id FROM narrative_attempts WHERE session_id=$1", [sessionId])).rows.length, 0);
      assert.equal((await pg.query("SELECT id FROM game_turns WHERE session_id=$1 AND role='narrator'", [sessionId])).rows.length, 1);
      await pending[0]();
      const attempts = (await pg.query<{ outcome: string; payload: { decision: string } }>("SELECT outcome,payload FROM narrative_attempts WHERE session_id=$1", [sessionId])).rows;
      assert.equal(attempts[0].outcome, "completed");
      assert.equal(attempts[0].payload.decision, "skipped_offline");
    });
    await t.test("guarded offline preset needs no provider and persists deterministic consequences", async () => {
      const sessionId = randomUUID();
      await pg.query("INSERT INTO game_sessions(id,title,campaign_mode,rules_profile,character,world_state,turn_count,owner_id) VALUES ($1,'Offline','preset','d20',$2,$3,1,'offline-owner')", [sessionId, JSON.stringify(character), JSON.stringify(world)]);
      const fetchMock = mock.method(globalThis, "fetch", async () => { throw new Error("Offline called a provider"); });
      try {
        const result = await performTurn({ sessionId, requestId: randomUUID(), expectedTurn: 1, isFree: true, action: "Осмотреться" }, {
          loadAIConfig: async () => ({ ...cfg, keys: [], canUseLive: false, useLiveAI: false }),
          loadNarrativeConfig: async () => ({ enabled: true, provider: "openrouter", apiKey: "" }), schedule() {},
        });
        assert.ok(result.ok, JSON.stringify(result));
        assert.match(result.narration, /Автономный режим пресета/);
        assert.equal(fetchMock.mock.callCount(), 0);
        const row = await pg.query<{ content: string }>("SELECT content FROM game_turns WHERE session_id=$1 AND role='narrator'", [sessionId]);
        assert.equal(row.rows[0].content, result.narration);
      } finally { fetchMock.mock.restore(); }
    });
  } finally { queryMock.mock.restore(); connectMock.mock.restore(); await pg.close(); }
});
