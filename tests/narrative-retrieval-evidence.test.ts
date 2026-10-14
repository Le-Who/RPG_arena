import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import type { AIConfig } from "../src/lib/ai-settings";
import type { NarrativeEvidence } from "../src/lib/narrative-evidence";
import { buildMemoryQuery, queryVectorCache } from "../src/lib/query-vectors";
import { formatDocument } from "../src/lib/vector";

// Standard test preload removes credentials; every SQL call uses this disposable DB.
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/retrieval_evidence_test";

test("performTurn delivers retrieved original sources to generation, verification and committed audit", async t => {
  const { pool } = await import("../src/db");
  const { performTurn } = await import("../src/lib/turn");
  const { hashContent } = await import("../src/lib/memory");
  const { emptyChanges } = await import("../src/lib/resolution");
  const pg = new PGlite({ extensions: { vector, pgcrypto } });
  for (const file of (await readdir("drizzle")).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort())
    await pg.exec(await readFile(`drizzle/${file}`, "utf8"));
  let evidenceQueries = 0, failRetrieval = false;
  const stages: string[] = [];
  const run = async (query: string | { text: string; values?: unknown[]; rowMode?: string }, values?: unknown[]) => {
    const config = typeof query === "string" ? { text: query, values } : { ...query, values: values ?? query.values };
    if (config.text.startsWith("BEGIN;")) { await pg.exec(config.text); return { rows: [] }; }
    if (config.text.startsWith("WITH candidates AS")) { evidenceQueries++; stages.push("evidence"); }
    if (config.text.startsWith("WITH valid AS")) {
      stages.push("retrieval");
      if (failRetrieval) { await pg.exec("ROLLBACK"); throw new Error("synthetic retrieval failure"); }
    }
    const result = await pg.query<Record<string, unknown>>(config.text, config.values);
    const normalize = (v: unknown) => v instanceof Date ? v.toISOString() : v;
    return { ...result, rows: result.rows.map(row => config.rowMode === "array"
      ? result.fields.map(field => normalize(row[field.name]))
      : Object.fromEntries(Object.entries(row).map(([key, v]) => [key, normalize(v)]))) };
  };
  const queryMock = mock.method(pool, "query", run as never);
  const connectMock = mock.method(pool, "connect", async () => ({ query: run, release() {} }) as never);
  const cfg: AIConfig = {
    keys: ["synthetic-key"], dbKeyCount: 1, envKeyCount: 0, useLiveAI: true, canUseLive: true,
    routingConfig: { profile: "balanced", narrationModel: "gemini-3.5-flash-lite", customActionModel: "gemini-3.8-flash", compactionModel: "gemini-3.8-flash", fastTaskModel: "gemini-3.5-flash-lite" },
    limits: { flash: 20, lite: 500 }, enforceLimits: false,
    embeddingsEnabled: true, embeddingModel: "gemini-embedding-2", embeddingDims: 768, semanticExtractionEnabled: true,
  };
  const character = { name: "Сигнал", archetype: "Сознание", level: 1, xp: 0, hp: 20, maxHp: 20, gold: 0, stats: {}, skills: [], traits: [], conditions: [], backstory: "", appearance: "" };
  const world = { worldName: "Резонанс", tone: "Созерцание", era: "Вне календаря", mainQuest: "Понять сообщение", currentLocation: "Поле", factions: [], flags: {}, danger: 0, chapter: 1 };
  const original = "А сообщил Б: В уверен, что резонанс не произошёл. Б услышал сообщение и отверг его.";
  const correction = "Позднее А признал: причина резонанса неизвестна.";
  const action = "Продолжаю путь";
  const narration = "Сигнал движется дальше по полю.";
  const draft = { continuity: { mode: "event", referencesPast: true }, outcome: "neutral", effects: { hp: 0, xp: 0, gold: 0, danger: 0 }, stateChanges: emptyChanges(), choices: ["Осмотреть поле"], narration };
  try {
    const cases = [
      ...["free", "preset"].flatMap(mode => ["narrative", "rules-light", "d20"].map(profile => ({ mode, profile, path: "hit" }))),
      ...["disabled", "empty", "failed", "guard-off"].map(path => ({ mode: "free", profile: "narrative", path })),
    ];
    for (const { mode, profile, path } of cases) await t.test(`${mode}/${profile}/${path}`, async () => {
      const sessionId = randomUUID(), nodeId = randomUUID();
      await pg.query("INSERT INTO game_sessions(id,title,campaign_mode,rules_profile,character,world_state,turn_count,owner_id) VALUES ($1,'Synthetic evidence',$2,$3,$4,$5,100,$6)",
        [sessionId, mode, profile, JSON.stringify(character), JSON.stringify(world), `fixture-${sessionId}`]);
      await pg.query(`INSERT INTO game_turns(session_id,turn_number,role,content,state_changes)
        SELECT $1,n,role,CASE WHEN n=10 AND role='narrator' THEN $2
          WHEN n=10 THEN 'Пытаюсь убедить Б.' WHEN n=11 AND role='narrator' THEN $3 ELSE 'Тихое мерцание.' END, '{}'::jsonb
        FROM generate_series(1,100) n CROSS JOIN (VALUES ('player'),('narrator')) roles(role)`, [sessionId, original, correction]);
      // More than loadRankedNodes' 60 rows: the only vector hit is excluded from the global digest.
      await pg.query(`INSERT INTO memory_nodes(session_id,layer,category,title,content,source,source_turn,turn_from,turn_to,importance,salience)
        SELECT $1,'semantic','event','Фоновая запись '||n,'Мерцание','state',n,n,n,100,100 FROM generate_series(30,89) n`, [sessionId]);
      const title = "Вложенное сообщение", content = "Сведения о резонансе";
      await pg.query(`INSERT INTO memory_nodes(id,session_id,layer,category,title,content,source,source_turn,turn_to,importance,salience,evidence)
        VALUES ($1,$2,'semantic','event',$3,$4,'ai-semantic',10,11,1,1,$5)`, [nodeId, sessionId, title, content, original]);
      const embedding = Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0);
      if (path !== "empty") await pg.query(`INSERT INTO memory_embeddings(memory_node_id,session_id,model,dims,status,content_hash,vector)
        VALUES ($1,$2,$3,768,'ready',$4,$5::real[])`, [nodeId, sessionId, cfg.embeddingModel, hashContent(cfg.embeddingModel, "768", formatDocument(title, content)), embedding]);
      await queryVectorCache.prewarm([hashContent(sessionId, cfg.embeddingModel, "768", buildMemoryQuery(action, world.currentLocation, "Тихое мерцание."))], async () => [embedding]);
      evidenceQueries = 0; stages.length = 0; failRetrieval = path === "failed";
      const checked: NarrativeEvidence[] = [], generationEvidence: NarrativeEvidence[] = [];
      const fetchMock = mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
        // Cache prewarm is synthetic: neither embeddings nor real generation may escape this mock.
        assert.match(String(url), /:generateContent$/);
        const request = JSON.parse(String(init?.body));
        const user: string = request.contents[0].parts[0].text;
        const encoded = user.split("\nORIGINAL_EVIDENCE:\n")[1]?.split("\nAGREEMENT_HISTORY")[0];
        if (encoded) generationEvidence.push(JSON.parse(encoded));
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(draft) }] }, finishReason: "STOP" }] });
      });
      try {
        const result = await performTurn({ sessionId, requestId: randomUUID(), expectedTurn: 100, isFree: true, action }, {
          loadAIConfig: async () => ({ ...cfg, embeddingsEnabled: path !== "disabled" }),
          loadNarrativeConfig: async () => ({ enabled: path !== "guard-off", provider: "openrouter", apiKey: "synthetic-key" }),
          schedule() {}, scheduleDiagnostics() {},
          verifyNarrative: async input => {
            const { agreements: _agreements, ...evidence } = input.state.historical_evidence as NarrativeEvidence & { agreements: unknown };
            checked.push(evidence);
            return { status: "verified", provider: "openrouter", model: "fixture", answers: {}, latencyMs: 0 };
          },
        });
        assert.ok(result.ok, JSON.stringify(result));
        assert.equal(fetchMock.mock.callCount(), 1);
        const saved = (await pg.query<{ content: string; choices: string[]; state_changes: unknown; context_meta: { narrativeVerification?: { evidence: NarrativeEvidence } } }>(
          "SELECT content,choices,state_changes,context_meta FROM game_turns WHERE session_id=$1 AND turn_number=101 AND role='narrator'", [sessionId])).rows[0];
        assert.equal(saved.content, result.narration); assert.deepEqual(saved.choices, result.choices); assert.deepEqual(saved.state_changes, result.applied);
        const job = (await pg.query<{ payload: { narration: string } }>("SELECT payload FROM memory_jobs WHERE session_id=$1", [sessionId])).rows[0];
        assert.equal(job.payload.narration, result.narration);
        if (path === "guard-off") {
          assert.equal(evidenceQueries, 0); assert.deepEqual(generationEvidence, []); assert.deepEqual(checked, []);
          return;
        }
        assert.equal(evidenceQueries, 1);
        assert.equal(checked.length, 1);
        assert.deepEqual(checked[0], generationEvidence[0]);
        assert.deepEqual(saved.context_meta.narrativeVerification?.evidence, checked[0]);
        assert.equal(checked[0].completeHistory, false);
        if (path === "hit") {
          assert.ok(result.retrieved?.some(n => n.id === nodeId));
          assert.ok(checked[0].sources.some(s => s.turn === 10 && s.role === "narrator" && s.text === original), "retrieved sourceTurn must reach the final evidence snapshot");
          assert.ok(checked[0].sources.some(s => s.turn === 11 && s.text === correction), "retrieved turnTo is also a bounded source pointer");
          assert.ok(checked[0].sources.some(s => s.turn === 10 && s.role === "player" && s.authority === "intention"));
          assert.equal(checked[0].sources.find(s => s.text === original)?.authority, "legacy_narration", "retrieval never promotes a message to verified canon");
          assert.deepEqual(stages, ["retrieval", "evidence"]);
        } else {
          assert.ok(checked[0].sources.some(s => s.turn === 30), "global fallback survives unavailable retrieval");
          assert.ok(!checked[0].sources.some(s => s.text === original));
          if (path === "failed") assert.ok(result.warnings?.some(w => w.includes("retrieval")));
        }
      } finally { fetchMock.mock.restore(); }
    });
  } finally { queryMock.mock.restore(); connectMock.mock.restore(); await pg.close(); }
});
