// Explicit opt-in only: fixed disposable loopback database, never reads .env.
import "../helpers/test-environment";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import type { AIConfig } from "../../src/lib/ai-settings";
import type { TurnRuntime } from "../../src/lib/turn";
import type { TurnResponse } from "../../src/lib/turn-contract";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 8000); }),
    ]);
  } finally { clearTimeout(timer); }
}

const character = {
  name: "Искатель", archetype: "Путник", level: 1, xp: 0, hp: 20, maxHp: 20, gold: 5,
  stats: {}, skills: [], traits: [], conditions: [], backstory: "", appearance: "",
};
const world = {
  worldName: "Гавань", tone: "Повседневность", era: "Сегодня", mainQuest: "Осмотреть причал",
  currentLocation: "Причал", factions: [], flags: {}, danger: 0, chapter: 1,
};
const cfg: AIConfig = {
  keys: ["synthetic-turn-provider"], dbKeyCount: 1, envKeyCount: 0, useLiveAI: true, canUseLive: true,
  routingConfig: {
    profile: "balanced", narrationModel: "gemini-3.5-flash-lite", customActionModel: "gemini-3.8-flash",
    compactionModel: "gemini-3.8-flash", fastTaskModel: "gemini-3.5-flash-lite",
  },
  limits: { flash: 20, lite: 500 }, enforceLimits: true,
  embeddingsEnabled: false, embeddingModel: "gemini-embedding-2", embeddingDims: 768, semanticExtractionEnabled: true,
};
function draft(narration: string) {
  return {
    outcome: "neutral", effects: { hp: 0, xp: 0, gold: 0, danger: 0 },
    stateChanges: {
      location: null, locations: [], routes: [], quests: [], npcs: [], inventory: [],
      sceneObjects: [{ ref: "", name: "Тумба", state: "осмотрена", note: "Каменная тумба на причале." }],
      conditions: { add: [], remove: [] }, flags: { inspected: true },
    },
    choices: ["Продолжить прогулку"], narration,
  };
}
function providerResponse(narration: string) {
  return Response.json({
    candidates: [{ content: { parts: [{ text: JSON.stringify(draft(narration)) }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 },
  });
}
function assertDurableResult(result: TurnResponse, live: TurnResponse, requestId: string, narration: string) {
  assert.deepEqual({
    ok: result.ok, narration: result.narration, choices: result.choices, turnNumber: result.turnNumber,
    requestId: result.requestId, dice: result.dice,
    character: result.state?.character,
    location: result.state?.worldState.currentLocation, flags: result.state?.worldState.flags,
    applied: {
      hp: result.applied.hp, xp: result.applied.xp, gold: result.applied.gold, danger: result.applied.danger,
      sceneObjects: result.applied.sceneObjects,
    },
  }, {
    ok: true, narration, choices: ["Продолжить прогулку"], turnNumber: 2, requestId, dice: null,
    character, location: "Причал", flags: { inspected: true },
    applied: { hp: 0, xp: 0, gold: 0, danger: 0, sceneObjects: [{ name: "Тумба", state: "осмотрена", isNew: true }] },
  });
  // The live return adds observational server timing after COMMIT. All gameplay fields must round-trip.
  const durableGameplay = { ...result }, liveGameplay = { ...live };
  delete durableGameplay.timings; delete liveGameplay.timings;
  assert.deepEqual(durableGameplay, liveGameplay);
}
const runtime: TurnRuntime = {
  loadAIConfig: async () => cfg,
  loadNarrativeConfig: async () => ({ enabled: false, provider: "openrouter", apiKey: "" }),
  // Keep durable outbox rows pending and prevent background transport from obscuring admission counts.
  schedule() {}, scheduleDiagnostics() {},
};

test("native PostgreSQL full turns preserve contention, fencing and atomic completion", {
  skip: process.env.CHRONICLE_RUN_TURN_POSTGRES !== "1", timeout: 90000,
}, async t => {
  // The safe preload above clears inherited provider/vault credentials. Clear libpq defaults too.
  for (const name of Object.keys(process.env)) if (name.startsWith("PG")) delete process.env[name];
  const url = new URL("postgresql://chronicle_test:fixture-only@127.0.0.1:55439/chronicle_auth_test");
  const schema = `turn_task1_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, /^turn_task1_[a-f0-9]{32}$/);
  const bootstrap = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  let pool: Pool | undefined;
  let control: Pool | undefined;
  let created = false;
  try {
    await bootstrap.query(`CREATE SCHEMA ${schema}`);
    created = true;
    url.searchParams.set("options", `-csearch_path=${schema},public -cstatement_timeout=10000`);
    process.env.DATABASE_URL = url.toString();
    ({ pool } = await import("../../src/db"));
    control = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
    // Portable PostgreSQL has no pgvector. Preserve immutable 0006; vector search/readiness are excluded.
    for (const file of (await readdir("drizzle")).filter(file => /^\d{4}_.*\.sql$/.test(file) && !file.startsWith("0006_")).sort()) {
      await pool.query((await readFile(`drizzle/${file}`, "utf8")).replaceAll('"public".', `"${schema}".`));
    }
    const { performTurn } = await import("../../src/lib/turn");
    const sqlPool = pool;
    const controlPool = control;
    const insertSession = async () => {
      const sessionId = randomUUID();
      await sqlPool.query(
        "INSERT INTO game_sessions(id,title,campaign_mode,rules_profile,character,world_state,turn_count,owner_id,updated_at) VALUES ($1,'Native turn fixture','free','narrative',$2,$3,1,$4,'2026-01-01 00:00:00')",
        [sessionId, JSON.stringify(character), JSON.stringify(world), `turn-owner-${sessionId}`],
      );
      return sessionId;
    };
    const snapshot = async (sessionId: string) => ({
      session: (await controlPool.query(`SELECT character,world_state,turn_count,context_tokens_estimate,to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS updated_at FROM game_sessions WHERE id=$1`, [sessionId])).rows[0],
      turns: (await controlPool.query("SELECT turn_number,role,content,request_id FROM game_turns WHERE session_id=$1 ORDER BY turn_number,role", [sessionId])).rows,
      jobs: (await controlPool.query("SELECT turn_number,kind,status,payload FROM memory_jobs WHERE session_id=$1 ORDER BY turn_number,kind", [sessionId])).rows,
      scene: (await controlPool.query("SELECT name,state,location_name FROM scene_objects WHERE session_id=$1 ORDER BY key", [sessionId])).rows,
      memories: (await controlPool.query("SELECT entity_key,content,source_turn FROM memory_nodes WHERE session_id=$1 ORDER BY entity_key,content", [sessionId])).rows,
      embeddings: (await controlPool.query("SELECT status,attempts FROM memory_embeddings WHERE session_id=$1 ORDER BY id", [sessionId])).rows,
    });
    const inputFor = (sessionId: string) => ({ sessionId, requestId: randomUUID(), expectedTurn: 1, isFree: true, action: "Осматриваю причал" });

    await t.test("six simultaneous repeats call provider once, commit one pair and replay the exact durable result", { timeout: 20000 }, async () => {
      // Catches admission outside the session lock or replay that executes a turn again.
      const sessionId = await insertSession(), input = inputFor(sessionId);
      const start = barrier(), entered = barrier(), release = barrier(), rejected = barrier();
      let calls = 0, finished = 0;
      const fetchMock = mock.method(globalThis, "fetch", async () => {
        calls++; entered.release(); await release.promise;
        return providerResponse("Ты осматриваешь тихий причал.");
      });
      const callers = Array.from({ length: 6 }, async () => {
        await start.promise;
        try { return await performTurn(input, runtime); }
        finally { if (++finished === 5) rejected.release(); }
      });
      try {
        start.release();
        await bounded(entered.promise, "winning provider entry");
        await bounded(rejected.promise, "five repeats rejected while provider is held");
        assert.equal(calls, 1);
        const pending = (await controlPool.query("SELECT status,stage,attempts,result FROM turn_requests WHERE session_id=$1", [sessionId])).rows;
        assert.deepEqual(pending, [{ status: "running", stage: "generation", attempts: 1, result: null }]);
        assert.deepEqual((await snapshot(sessionId)).turns, []);
        release.release();
        const results = await bounded(Promise.all(callers), "six caller completion");
        assert.equal(results.filter(result => result.ok).length, 1);
        assert.deepEqual(results.filter(result => !result.ok).map(result => result.code), ["BUSY", "BUSY", "BUSY", "BUSY", "BUSY"]);
        const winner = results.find(result => result.ok)!;
        assert.equal(winner.turnNumber, 2);
        assert.equal(winner.narration, "Ты осматриваешь тихий причал.");
        assert.deepEqual(winner.choices, ["Продолжить прогулку"]);
        assert.equal(winner.dice, null);
        assert.equal(winner.modelUsed, "gemini-3.8-flash");
        const committed = await snapshot(sessionId);
        assert.equal(committed.session.turn_count, 2);
        assert.deepEqual(committed.session.character, character);
        assert.equal(committed.session.world_state.flags.inspected, true);
        assert.deepEqual(committed.turns, [
          { turn_number: 2, role: "narrator", content: "Ты осматриваешь тихий причал.", request_id: null },
          { turn_number: 2, role: "player", content: "Осматриваю причал", request_id: input.requestId },
        ]);
        assert.equal(committed.jobs.length, 1);
        assert.deepEqual({ ...committed.jobs[0], payload: undefined }, { turn_number: 2, kind: "semantic", status: "pending", payload: undefined });
        assert.equal(committed.jobs[0].payload.narration, "Ты осматриваешь тихий причал.");
        assert.equal(committed.jobs[0].payload.playerAction, "Осматриваю причал");
        assert.deepEqual(committed.scene, [{ name: "Тумба", state: "осмотрена", location_name: "Причал" }]);
        assert.equal(committed.memories.length, 1);
        assert.equal(committed.memories[0].source_turn, 2);
        assert.deepEqual(committed.embeddings, [{ status: "pending", attempts: 0 }]);
        const requests = (await controlPool.query("SELECT status,stage,attempts,result,lease_token,lease_expires_at,error FROM turn_requests WHERE session_id=$1", [sessionId])).rows;
        assert.equal(requests.length, 1);
        assert.deepEqual({ ...requests[0], result: undefined }, { status: "completed", stage: "completed", attempts: 1, result: undefined, lease_token: null, lease_expires_at: null, error: null });
        assertDurableResult(requests[0].result, winner, input.requestId, "Ты осматриваешь тихий причал.");
        const replay = await performTurn(input, runtime);
        assert.deepEqual(replay, { ...requests[0].result, replay: true });
        assert.equal(calls, 1);
        assert.deepEqual(await snapshot(sessionId), committed);
      } finally {
        start.release(); release.release();
        await Promise.allSettled(callers);
        fetchMock.mock.restore();
      }
    });

    await t.test("expired lease is replaced and stale full-turn work cannot alter the replacement", { timeout: 20000 }, async () => {
      // Catches token-blind stage/commit/failure updates that let a late attempt corrupt its successor.
      const sessionId = await insertSession(), input = inputFor(sessionId);
      const entered = [barrier(), barrier()], release = [barrier(), barrier()];
      let calls = 0;
      const fetchMock = mock.method(globalThis, "fetch", async () => {
        const index = calls++;
        assert.ok(index < 2, "only the stale attempt and its replacement may reach transport");
        entered[index].release(); await release[index].promise;
        return providerResponse(index === 0 ? "Старый ответ: причал пуст." : "Новый ответ: над причалом кружат чайки.");
      });
      const stale = performTurn(input, runtime);
      let replacement: ReturnType<typeof performTurn> | undefined;
      try {
        await bounded(entered[0].promise, "stale provider entry");
        const first = (await controlPool.query("SELECT id,lease_token FROM turn_requests WHERE session_id=$1", [sessionId])).rows[0];
        await controlPool.query("UPDATE turn_requests SET lease_expires_at='2000-01-01 00:00:00' WHERE id=$1", [first.id]);
        replacement = performTurn(input, runtime);
        await bounded(entered[1].promise, "replacement provider entry");
        const replacementRequest = (await controlPool.query("SELECT id,status,stage,attempts,lease_token,lease_expires_at,result,error FROM turn_requests WHERE session_id=$1", [sessionId])).rows;
        assert.equal(replacementRequest.length, 1);
        assert.equal(replacementRequest[0].id, first.id);
        assert.notEqual(replacementRequest[0].lease_token, first.lease_token);
        assert.equal(replacementRequest[0].attempts, 2);
        assert.equal(replacementRequest[0].status, "running");
        assert.equal(replacementRequest[0].stage, "generation");
        assert.equal(replacementRequest[0].result, null);
        assert.equal(replacementRequest[0].error, null);
        const beforeStaleRelease = await snapshot(sessionId);
        release[0].release();
        const staleResult = await bounded(stale, "stale attempt rejection");
        assert.equal(staleResult.ok, false);
        if (staleResult.ok) assert.fail("stale attempt committed");
        assert.equal(staleResult.code, "LEASE_EXPIRED");
        assert.deepEqual((await controlPool.query("SELECT id,status,stage,attempts,lease_token,lease_expires_at,result,error FROM turn_requests WHERE session_id=$1", [sessionId])).rows, replacementRequest);
        assert.deepEqual(await snapshot(sessionId), beforeStaleRelease);
        release[1].release();
        const accepted = await bounded(replacement, "replacement turn commit");
        assert.equal(accepted.ok, true);
        if (!accepted.ok) assert.fail(JSON.stringify(accepted));
        assert.equal(accepted.narration, "Новый ответ: над причалом кружат чайки.");
        const committed = await snapshot(sessionId);
        assert.equal(committed.session.turn_count, 2);
        assert.equal(committed.turns.length, 2);
        assert.equal(committed.jobs.length, 1);
        assert.equal(committed.turns.find(turn => turn.role === "narrator")?.content, "Новый ответ: над причалом кружат чайки.");
        const request = (await controlPool.query("SELECT status,attempts,result,error,lease_token FROM turn_requests WHERE session_id=$1", [sessionId])).rows[0];
        assert.deepEqual({ ...request, result: undefined }, { status: "completed", attempts: 2, result: undefined, error: null, lease_token: null });
        assertDurableResult(request.result, accepted, input.requestId, "Новый ответ: над причалом кружат чайки.");
        assert.deepEqual(await performTurn(input, runtime), { ...request.result, replay: true });
        assert.equal(calls, 2);
      } finally {
        for (const gate of release) gate.release();
        await Promise.allSettled([stale, ...(replacement ? [replacement] : [])]);
        fetchMock.mock.restore();
      }
    });

    await t.test("lease expiry after applying is fenced inside the blocked commit transaction", { timeout: 20000 }, async () => {
      // Catches removal of the final transaction fence after pre-commit stage validation.
      const sessionId = await insertSession(), input = inputFor(sessionId), applying = barrier();
      const entered = barrier(), release = barrier();
      const before = await snapshot(sessionId);
      const locker = await controlPool.connect();
      let attempt: ReturnType<typeof performTurn> | undefined;
      const fetchMock = mock.method(globalThis, "fetch", async () => {
        entered.release(); await release.promise;
        return providerResponse("Ответ приходит после истечения права обработки.");
      });
      try {
        attempt = performTurn(input, { ...runtime, onEvent: event => { if (event.type === "stage" && event.stage === "applying") applying.release(); } });
        await bounded(entered.promise, "commit-fencing provider entry");
        await locker.query("BEGIN");
        await locker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
        release.release();
        await bounded(applying.promise, "applying stage before locked commit");
        await locker.query("UPDATE turn_requests SET lease_expires_at='2000-01-01 00:00:00' WHERE session_id=$1", [sessionId]);
        await locker.query("COMMIT");
        const result = await bounded(attempt, "expired commit rejection");
        assert.equal(result.ok, false);
        if (result.ok) assert.fail("expired commit succeeded");
        assert.equal(result.code, "LEASE_EXPIRED");
        assert.deepEqual(await snapshot(sessionId), before);
        assert.deepEqual((await controlPool.query("SELECT status,stage,error,result,lease_token FROM turn_requests WHERE session_id=$1", [sessionId])).rows, [{ status: "failed", stage: "failed", error: "LEASE_EXPIRED", result: null, lease_token: null }]);
      } finally {
        release.release();
        await locker.query("ROLLBACK");
        if (attempt) await Promise.allSettled([attempt]);
        locker.release(); fetchMock.mock.restore();
      }
    });

    await t.test("SQL failure at completed request persistence rolls back state, turns, memories and jobs together", { timeout: 20000 }, async () => {
      // Catches state/turn/outbox writes moved outside the request-completion transaction.
      const sessionId = await insertSession(), input = inputFor(sessionId);
      const before = await snapshot(sessionId);
      assert.deepEqual(before, {
        session: { character, world_state: world, turn_count: 1, context_tokens_estimate: 0, updated_at: "2026-01-01T00:00:00" },
        turns: [], jobs: [], scene: [], memories: [], embeddings: [],
      });
      await controlPool.query(`CREATE FUNCTION reject_fixture_completion() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.status = 'completed' THEN
            IF (SELECT turn_count FROM game_sessions WHERE id=NEW.session_id) <> 2
              OR (SELECT world_state->'flags'->>'inspected' FROM game_sessions WHERE id=NEW.session_id) <> 'true'
              OR (SELECT count(*) FROM game_turns WHERE session_id=NEW.session_id) <> 2
              OR (SELECT count(*) FROM memory_jobs WHERE session_id=NEW.session_id AND kind='semantic') <> 1
              OR (SELECT count(*) FROM scene_objects WHERE session_id=NEW.session_id) <> 1
              OR (SELECT count(*) FROM memory_nodes WHERE session_id=NEW.session_id) <> 1
              OR (SELECT count(*) FROM memory_embeddings WHERE session_id=NEW.session_id AND status='pending') <> 1 THEN
              RAISE EXCEPTION 'fixture completion reached without all transactional writes';
            END IF;
            RAISE EXCEPTION 'fixture completed-request persistence failure after state, turns and jobs';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER reject_fixture_completion BEFORE UPDATE ON turn_requests FOR EACH ROW EXECUTE FUNCTION reject_fixture_completion();`);
      let calls = 0;
      const fetchMock = mock.method(globalThis, "fetch", async () => { calls++; return providerResponse("Ты отмечаешь, что причал осмотрен."); });
      try {
        await assert.rejects(performTurn(input, runtime), error => {
          const cause = (error as Error & { cause?: Error }).cause;
          assert.match(cause?.message ?? String(error), /fixture completed-request persistence failure after state, turns and jobs/);
          return true;
        });
        assert.equal(calls, 1);
        assert.deepEqual(await snapshot(sessionId), before);
        assert.deepEqual((await controlPool.query("SELECT status,stage,attempts,error,result,lease_token,lease_expires_at FROM turn_requests WHERE session_id=$1", [sessionId])).rows, [{ status: "failed", stage: "failed", attempts: 1, error: "INTERNAL", result: null, lease_token: null, lease_expires_at: null }]);
      } finally {
        fetchMock.mock.restore();
        await controlPool.query("DROP TRIGGER reject_fixture_completion ON turn_requests; DROP FUNCTION reject_fixture_completion()");
      }
    });
  } finally {
    await control?.end();
    await pool?.end();
    if (created) await bootstrap.query(`DROP SCHEMA ${schema} CASCADE`);
    await bootstrap.end();
  }
});
