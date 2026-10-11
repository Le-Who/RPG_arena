// Explicit opt-in, synthetic loopback database only; never loads .env or live provider credentials.
import "../helpers/test-environment";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { sealSecret, secretContext } from "../../src/lib/secret-vault";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 8000); })]); }
  finally { clearTimeout(timer); }
}

test("native PostgreSQL compaction commits one complete excerpt batch under independent contention", {
  skip: process.env.CHRONICLE_RUN_MEMORY_POSTGRES !== "1", timeout: 60000,
}, async t => {
  for (const name of Object.keys(process.env)) if (name.startsWith("PG")) delete process.env[name];
  const url = new URL("postgresql://chronicle_test:fixture-only@127.0.0.1:55439/chronicle_auth_test");
  const schema = `memory_p1_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, /^memory_p1_[a-f0-9]{32}$/);
  const bootstrap = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  let pool: Pool | undefined, control: Pool | undefined, created = false;
  try {
    await bootstrap.query(`CREATE SCHEMA ${schema}`); created = true;
    url.searchParams.set("options", `-csearch_path=${schema},public -cstatement_timeout=10000`);
    url.searchParams.set("application_name", schema);
    process.env.DATABASE_URL = url.toString();
    process.env.CHRONICLE_SECRET_ACTIVE_KEY = "memory-fixture";
    process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ "memory-fixture": Buffer.alloc(32, 21).toString("base64") });
    ({ pool } = await import("../../src/db"));
    control = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
    // Standard PG lacks pgvector: 0006 stays immutable; vector search/readiness is outside this fixture.
    // Apply every other historical migration (currently through 0019), including future append-only migrations.
    for (const file of (await readdir("drizzle")).filter(file => /^\d{4}_.*\.sql$/.test(file) && !file.startsWith("0006_")).sort()) {
      await pool.query((await readFile(`drizzle/${file}`, "utf8")).replaceAll('"public".', `"${schema}".`));
    }
    const sqlPool = pool, controlPool = control;
    const { compactSession } = await import("../../src/lib/compaction");
    const insertSession = async (live: boolean) => {
      const sessionId = randomUUID(), owner = `memory-native-${sessionId}`;
      await sqlPool.query("INSERT INTO ai_settings(id,keys,use_live_ai,enforce_limits) VALUES ($1,$2,$3,false)", [owner,
        JSON.stringify(live ? [sealSecret("synthetic-memory-native", secretContext(owner, "gemini"))] : []), live]);
      await sqlPool.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state,turn_count) VALUES ($1,$2,'Native memory','{}','{}',2)", [sessionId, owner]);
      await sqlPool.query("INSERT INTO game_turns(session_id,turn_number,role,content) VALUES ($1,1,'narrator',$2),($1,1,'player','Хочу открыть ворота.'),($1,2,'narrator','Лена обещает встретить героя на рассвете.'),($1,2,'player','Прошу о встрече.')", [sessionId, "А".repeat(750) + "🌿"]);
      return sessionId;
    };
    const snapshot = async (sessionId: string) => ({
      cursor: (await controlPool.query("SELECT last_compact_turn FROM game_sessions WHERE id=$1", [sessionId])).rows[0].last_compact_turn,
      nodes: (await controlPool.query("SELECT entity_key,layer,content,source,source_turn,turn_from,turn_to FROM memory_nodes WHERE session_id=$1 ORDER BY entity_key", [sessionId])).rows,
      embeddings: (await controlPool.query("SELECT status,attempts FROM memory_embeddings WHERE session_id=$1 ORDER BY id", [sessionId])).rows,
    });

    await t.test("three independently blocked apply transactions produce five exact excerpts and advance the cursor once", async () => {
      // Catches dropping the cursor fence, moving cursor outside the transaction, and duplicate excerpt batches.
      const sessionId = await insertSession(true);
      await controlPool.query(`CREATE TABLE compaction_write_audit(session_id uuid,table_name text,operation text);
        CREATE FUNCTION audit_compaction_writes() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          INSERT INTO compaction_write_audit VALUES ((CASE WHEN TG_TABLE_NAME='game_sessions' THEN to_jsonb(NEW)->>'id' ELSE to_jsonb(NEW)->>'session_id' END)::uuid,TG_TABLE_NAME,TG_OP);
          RETURN NEW; END $$;
        CREATE TRIGGER audit_compaction_nodes AFTER INSERT OR UPDATE ON memory_nodes FOR EACH ROW EXECUTE FUNCTION audit_compaction_writes();
        CREATE TRIGGER audit_compaction_cursor AFTER UPDATE OF last_compact_turn ON game_sessions FOR EACH ROW EXECUTE FUNCTION audit_compaction_writes();`);
      const entered = barrier(), responseRelease = barrier(); let calls = 0;
      const fetch = mock.method(globalThis, "fetch", async () => {
        if (++calls === 3) entered.release();
        await responseRelease.promise;
        return Response.json({ candidates: [{ content: { parts: [{ text: "malformed synthetic summary" }] }, finishReason: "STOP" }] });
      });
      const pending = Array.from({ length: 3 }, () => compactSession(sessionId));
      const blocker = await controlPool.connect(); let locked = false;
      try {
        await bounded(entered.promise, "all three provider requests after snapshot selection");
        await blocker.query("BEGIN"); locked = true;
        await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
        responseRelease.release();
        const blocked = await bounded((async () => {
          const deadline = Date.now() + 7000;
          while (Date.now() < deadline) {
            const rows = (await controlPool.query("SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND wait_event='advisory'", [schema])).rows;
            if (rows.length === 3) return rows;
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          throw new Error("Three compaction apply connections did not reach the lock before the deadline");
        })(), "three independent connections waiting on canonical session lock");
        assert.equal(new Set(blocked.map(row => row.pid)).size, 3);
        assert.deepEqual(await snapshot(sessionId), { cursor: 0, nodes: [], embeddings: [] });
        await blocker.query("COMMIT"); locked = false;
        const results = await bounded(Promise.all(pending), "compaction commit completion");
        assert.equal(calls, 3);
        assert.deepEqual((await controlPool.query("SELECT table_name,operation,count(*)::integer AS writes FROM compaction_write_audit WHERE session_id=$1 GROUP BY table_name,operation ORDER BY table_name,operation", [sessionId])).rows,
          [{ table_name: "game_sessions", operation: "UPDATE", writes: 1 }, { table_name: "memory_nodes", operation: "INSERT", writes: 5 }]);
        assert.deepEqual(results.map(result => [result.created, result.mode, result.turnTo]).sort((a, b) => Number(b[0]) - Number(a[0])), [[5, "exact-excerpts", 2], [0, "already-applied", 2], [0, "already-applied", 2]]);
        const saved = await snapshot(sessionId);
        assert.equal(saved.cursor, 2);
        assert.deepEqual(saved.nodes, [
          { entity_key: "compact:1:narrator:0", layer: "episodic", content: "[Точный фрагмент ответа рассказчика, ход 1] " + "А".repeat(740), source: "compaction", source_turn: 1, turn_from: 1, turn_to: 1 },
          { entity_key: "compact:1:narrator:1", layer: "episodic", content: "[Точный фрагмент ответа рассказчика, ход 1] " + "А".repeat(10) + "🌿", source: "compaction", source_turn: 1, turn_from: 1, turn_to: 1 },
          { entity_key: "compact:1:player:0", layer: "chronicle", content: "[Намерение игрока — не подтверждённый исход, ход 1] Хочу открыть ворота.", source: "compaction", source_turn: 1, turn_from: 1, turn_to: 1 },
          { entity_key: "compact:2:narrator:0", layer: "episodic", content: "[Точный фрагмент ответа рассказчика, ход 2] Лена обещает встретить героя на рассвете.", source: "compaction", source_turn: 2, turn_from: 2, turn_to: 2 },
          { entity_key: "compact:2:player:0", layer: "chronicle", content: "[Намерение игрока — не подтверждённый исход, ход 2] Прошу о встрече.", source: "compaction", source_turn: 2, turn_from: 2, turn_to: 2 },
        ]);
        assert.deepEqual(saved.embeddings, Array.from({ length: 5 }, () => ({ status: "pending", attempts: 0 })));
        assert.deepEqual(await compactSession(sessionId), { ok: true, created: 0, mode: "up-to-date", turnTo: null });
        assert.deepEqual(await snapshot(sessionId), saved);
      } finally {
        responseRelease.release();
        if (locked) await blocker.query("ROLLBACK");
        blocker.release();
        await Promise.allSettled(pending); fetch.mock.restore();
      }
    });

    await t.test("cursor write failure rolls back all five excerpts and embedding rows", async () => {
      // Catches partial compaction becoming visible before the cursor's transaction can commit.
      const sessionId = await insertSession(false), before = await snapshot(sessionId);
      await controlPool.query(`CREATE FUNCTION reject_compaction_cursor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.last_compact_turn<>OLD.last_compact_turn THEN
          IF (SELECT count(*) FROM memory_nodes WHERE session_id=NEW.id AND source='compaction')<>5 OR
             (SELECT count(*) FROM memory_embeddings WHERE session_id=NEW.id)<>5 THEN
            RAISE EXCEPTION 'cursor reached without full excerpt batch';
          END IF;
          RAISE EXCEPTION 'synthetic cursor persistence failure after full excerpt batch';
        END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_compaction_cursor BEFORE UPDATE ON game_sessions FOR EACH ROW EXECUTE FUNCTION reject_compaction_cursor();`);
      try {
        await assert.rejects(compactSession(sessionId), error => {
          const cause = (error as Error & { cause?: Error }).cause;
          assert.match(cause?.message ?? String(error), /synthetic cursor persistence failure after full excerpt batch/);
          return true;
        });
        assert.deepEqual(await snapshot(sessionId), before);
      } finally { await controlPool.query("DROP TRIGGER reject_compaction_cursor ON game_sessions; DROP FUNCTION reject_compaction_cursor()"); }
    });
  } finally {
    delete process.env.CHRONICLE_SECRET_ACTIVE_KEY; delete process.env.CHRONICLE_SECRET_KEYS;
    await control?.end(); await pool?.end();
    if (created) await bootstrap.query(`DROP SCHEMA ${schema} CASCADE`);
    await bootstrap.end();
  }
});
