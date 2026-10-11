// Explicit native opt-in; no .env, inherited credentials, or external provider requests.
import "../helpers/test-environment";
import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cookieContext } from "../helpers/accounts-db";
import type { MemoryCycleReport } from "../../src/lib/background";
import type { AuthDatabase } from "../../src/lib/auth";

for (const name of Object.keys(process.env)) if (name.startsWith("PG")) delete process.env[name];
delete process.env.CHRONICLE_PUBLIC_ORIGIN;
delete process.env.CHRONICLE_AUTH_TRUSTED_CLIENT_HEADER;

type Event = { kind: string; id?: number; owner?: string; task?: string; pid?: number; backendPid?: number; report?: MemoryCycleReport; error?: string };
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 10000); })]);
  } finally { clearTimeout(timer); }
}
function worker(url: string) {
  const child = fork(fileURLToPath(new URL("../helpers/native-memory-queue-worker.ts", import.meta.url)), [url], {
    execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "", failure: Error | undefined;
  const events: Event[] = [];
  let waiting: { kind: string; resolve: (event: Event) => void; reject: (error: Error) => void } | undefined;
  child.stdout!.on("data", chunk => { output = (output + String(chunk)).slice(-8000); });
  child.stderr!.on("data", chunk => { output = (output + String(chunk)).slice(-8000); });
  child.on("message", (event: Event) => {
    if (event.kind === "error") { failure = new Error(`Worker error: ${event.error}; ${output}`); waiting?.reject(failure); waiting = undefined; }
    else if (waiting?.kind === event.kind) { waiting.resolve(event); waiting = undefined; }
    else events.push(event);
  });
  child.on("error", error => { failure = error; waiting?.reject(error); waiting = undefined; });
  const exited = new Promise<number | null>(resolve => child.on("exit", code => {
    failure = new Error(`Worker exited ${code}; ${output}`); waiting?.reject(failure); waiting = undefined; resolve(code);
  }));
  return {
    send(message: Event) { assert.equal(child.connected, true, output); child.send(message); },
    async next(kind: string) {
      if (failure) throw failure;
      const at = events.findIndex(event => event.kind === kind);
      if (at !== -1) return events.splice(at, 1)[0];
      assert.equal(waiting, undefined);
      return bounded(new Promise<Event>((resolve, reject) => { waiting = { kind, resolve, reject }; }), `worker ${kind}`);
    },
    async close() {
      if (child.connected) child.send({ kind: "stop" });
      let code: number | null;
      try { code = await bounded(exited, "worker stop"); } catch { child.kill(); await bounded(exited, "worker kill"); return; }
      assert.equal(code, 0, output);
    },
  };
}

test("native mixed-owner queue workers preserve service opportunities and admin retry ownership", {
  skip: process.env.CHRONICLE_RUN_QUEUE_POSTGRES !== "1", timeout: 90000,
}, async t => {
  const schema = `queue_p1_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, /^queue_p1_[0-9a-f]{32}$/);
  const url = new URL("postgresql://chronicle_test:fixture-only@127.0.0.1:55439/chronicle_auth_test");
  const bootstrap = new Pool({ connectionString: url.toString() });
  let createdSchema = false;
  const pools: Pool[] = [], workers: ReturnType<typeof worker>[] = [];
  try {
    await bootstrap.query(`CREATE SCHEMA "${schema}"`); createdSchema = true;
    url.searchParams.set("options", `-csearch_path=${schema},public -cstatement_timeout=10000 -clock_timeout=8000`);
    process.env.DATABASE_URL = url.toString();
    process.env.CHRONICLE_SECRET_ACTIVE_KEY = "queue-fixture";
    process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ "queue-fixture": Buffer.alloc(32, 17).toString("base64") });
    const { pool } = await import("../../src/db"); pools.push(pool);
    const independent = new Pool({ connectionString: url.toString() }); pools.push(independent);
    // Relational19/20; immutable0006 and native pgvector readiness are out of scope.
    for (const file of (await readdir("drizzle")).filter(file => /^\d{4}_.*\.sql$/.test(file) && !file.startsWith("0006_")).sort())
      await pool.query((await readFile(`drizzle/${file}`, "utf8")).replaceAll('"public".', `"${schema}".`));
    const { auth } = await import("../../src/lib/auth");
    const { sealSecret, secretContext } = await import("../../src/lib/secret-vault");
    const { hashContent } = await import("../../src/lib/memory");
    const { formatDocument } = await import("../../src/lib/vector");
    const accountA = await auth.register(randomBytes(32).toString("hex"), "queue-admin-a", "synthetic queue password A");
    const accountB = await auth.register(randomBytes(32).toString("hex"), "queue-user-b", "synthetic queue password B");
    const owners = { A: accountA.identity.profileId, B: accountB.identity.profileId };
    const sessions = { A: randomUUID(), B: randomUUID() };
    const nodes = { A: randomUUID(), B: randomUUID() };
    for (const label of ["A", "B"] as const) {
      await pool.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,$2,$3,'{}','{}')", [sessions[label], owners[label], `Queue ${label}`]);
      await pool.query("INSERT INTO ai_settings(id,keys,use_live_ai,embeddings_enabled,embedding_model,embedding_dims) VALUES ($1,$2,true,true,'gemini-embedding-2',128)", [owners[label], JSON.stringify([sealSecret(`queue-synthetic-${label}`, secretContext(owners[label], "gemini"))])]);
      for (const turn of [1, 2]) await pool.query("INSERT INTO memory_jobs(session_id,turn_number,payload,next_attempt_at) VALUES ($1,$2,$3,$4)", [sessions[label], turn, JSON.stringify({ narration: `Очередь ${label}, ход ${turn}: герой ждёт.`, playerAction: "Ждать", profileCanon: "narrative", knownDigest: "" }), label === "A" ? "2000-01-01T00:00:00Z" : "2000-01-02T00:00:00Z"]);
      await pool.query("INSERT INTO memory_nodes(id,session_id,layer,category,title,content,source) VALUES ($1,$2,'semantic','world',$3,$4,'seed')", [nodes[label], sessions[label], `Мир ${label}`, `Синтетический факт ${label}`]);
      await pool.query("INSERT INTO memory_embeddings(memory_node_id,session_id,model,dims,content_hash,next_attempt_at) VALUES ($1,$2,'gemini-embedding-2',128,$3,'2000-01-03')", [nodes[label], sessions[label], hashContent("gemini-embedding-2", "128", formatDocument(`Мир ${label}`, `Синтетический факт ${label}`))]);
    }

    await t.test("concurrent independent scheduler clients serialize opportunities across two eligible owners", async () => {
      const { selectNextMemoryCampaign } = await import("../../src/lib/owner-queue");
      const blocker = await independent.connect();
      const pids: number[] = [];
      const transport: AuthDatabase = {
        query: (sql, values) => pool.query(sql, values) as never,
        async transaction(run) {
          const client = await pool.connect();
          try {
            pids.push((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
            await client.query("BEGIN");
            const result = await run({ query: (sql, values) => client.query(sql, values) as never });
            await client.query("COMMIT"); return result;
          } catch (error) { await client.query("ROLLBACK"); throw error; }
          finally { client.release(); }
        },
      };
      let selections: Promise<({ id: string; ownerId: string } | undefined)[]> | undefined;
      let completed = false;
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT pg_advisory_xact_lock(9144,1)");
        selections = Promise.all([selectNextMemoryCampaign(transport), selectNextMemoryCampaign(transport)]).finally(() => { completed = true; });
        await bounded((async () => {
          while (!completed) {
            if (pids.length === 2) {
              const observed = await independent.query("SELECT pid,cardinality(pg_blocking_pids(pid))>0 AS blocked FROM pg_stat_activity WHERE pid=ANY($1::int[])", [pids]);
              if (observed.rows.length === 2 && observed.rows.every(row => row.blocked)) return;
            }
            await new Promise<void>(resolve => setImmediate(resolve));
          }
          throw new Error("Schedulers bypassed held selection lock");
        })(), "both scheduler clients blocked behind selection lock");
        assert.equal(completed, false);
        assert.notEqual(pids[0], pids[1]);
      } finally { await blocker.query("ROLLBACK"); blocker.release(); }
      try {
      const selected = await bounded(selections!, "serialized scheduler selections");
      assert.deepEqual(selected.map(row => row?.ownerId).sort(), Object.values(owners).sort());
      assert.deepEqual(selected.map(row => row?.id).sort(), Object.values(sessions).sort());
      assert.deepEqual((await independent.query("SELECT owner_id,served_count FROM owner_queue_service ORDER BY owner_id")).rows, Object.values(owners).sort().map(owner_id => ({ owner_id, served_count: 1 })));
      assert.equal((await independent.query("SELECT count(*)::int n FROM memory_jobs WHERE status='pending' AND attempts=0")).rows[0].n, 4);
      } finally { await independent.query("DELETE FROM owner_queue_service"); }
    });

    await t.test("independent worker processes serve B while A provider is held, then complete fixed mixed backlog", async () => {
      // Removing least-recently-served ordering must make the second selection A.
      const first = worker(url.toString()), second = worker(url.toString()); workers.push(first, second);
      try {
      const ready = await Promise.all([first.next("ready"), second.next("ready")]);
      assert.notEqual(ready[0].pid, ready[1].pid);
      assert.notEqual(ready[0].backendPid, ready[1].backendPid);
      t.diagnostic(`Independent worker processes: ${ready.map(event => `pid=${event.pid},backend=${event.backendPid}`).join("; ")}`);
      first.send({ kind: "tick" });
      const held = await first.next("provider");
      assert.deepEqual([held.owner, held.task], ["A", "semantic"]);
      assert.deepEqual((await independent.query("SELECT turn_number,status,attempts FROM memory_jobs WHERE session_id=$1 ORDER BY turn_number", [sessions.A])).rows, [
        { turn_number: 1, status: "processing", attempts: 1 }, { turn_number: 2, status: "pending", attempts: 0 },
      ]);
      const schedulerLocks = await independent.query("SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND classid=9144 AND objid=1 AND granted");
      assert.equal(schedulerLocks.rows[0].n, 0, "provider gate must outlive scheduler transaction");
      const step = async (owner: "A" | "B", embedding: boolean) => {
        second.send({ kind: "tick" });
        const semantic = await second.next("provider");
        assert.deepEqual([semantic.owner, semantic.task], [owner, "semantic"]);
        second.send({ kind: "release", id: semantic.id });
        if (embedding) {
          const vector = await second.next("provider");
          assert.deepEqual([vector.owner, vector.task], [owner, "embedding"]);
          second.send({ kind: "release", id: vector.id });
        }
        const report = (await second.next("report")).report!;
        assert.deepEqual({ processed: report.processed, extracted: report.extracted, indexed: report.indexed, failed: report.failed, paused: report.paused }, { processed: 1, extracted: 0, indexed: embedding ? 1 : 0, failed: 0, paused: false });
      };
      try {
        await step("B", true);
        assert.equal((await independent.query("SELECT status FROM memory_jobs WHERE session_id=$1 AND turn_number=1", [sessions.A])).rows[0].status, "processing");
        await step("A", true);
        await step("B", false);
      } finally { first.send({ kind: "release", id: held.id }); }
      const final = (await first.next("report")).report!;
      assert.deepEqual([final.processed, final.indexed, final.failed], [1, 0, 0]);
      assert.deepEqual((await independent.query("SELECT owner_id,served_count FROM owner_queue_service ORDER BY owner_id")).rows, Object.values(owners).sort().map(owner_id => ({ owner_id, served_count: 2 })));
      for (const label of ["A", "B"] as const) {
        assert.deepEqual((await independent.query("SELECT status,attempts,lease_token,lease_expires_at FROM memory_jobs WHERE session_id=$1 ORDER BY turn_number", [sessions[label]])).rows, [1, 2].map(() => ({ status: "completed", attempts: 1, lease_token: null, lease_expires_at: null })));
        const vector = (await independent.query("SELECT status,attempts,vector,lease_token,lease_expires_at FROM memory_embeddings WHERE session_id=$1", [sessions[label]])).rows[0];
        assert.deepEqual(vector, { status: "ready", attempts: 1, vector: Array.from({ length: 128 }, (_, i) => i === 0 ? 1 : label === "A" ? .5 : .25), lease_token: null, lease_expires_at: null });
        assert.deepEqual((await independent.query("SELECT owner_id,task_type,count(*)::int n FROM token_logs WHERE session_id=$1 GROUP BY owner_id,task_type ORDER BY task_type", [sessions[label]])).rows, [{ owner_id: owners[label], task_type: "embedding", n: 1 }, { owner_id: owners[label], task_type: "fast", n: 2 }]);
        assert.deepEqual((await independent.query("SELECT scope,attempts::int AS attempts FROM model_call_quotas WHERE owner_id=$1 ORDER BY scope", [owners[label]])).rows, [{ scope: "embedding", attempts: 1 }, { scope: "generation", attempts: 2 }]);
      }
      assert.equal((await independent.query("SELECT count(*)::int n FROM owner_activity")).rows[0].n, 0);
      } finally { await Promise.all(workers.splice(0).map(worker => worker.close())); }
    });

    await t.test("actual admin retry resets only A failed rows and preserves B plus completed/ready/pending rows", async () => {
      // Removing either retry ownership predicate must change the untouched snapshot.
      const failedJobs: string[] = [], failedVectors: string[] = [];
      for (const label of ["A", "B"] as const) {
        for (const status of ["failed", "pending"] as const) {
          const turn = status === "failed" ? 10 : 11, token = randomUUID();
          const job = await pool.query("INSERT INTO memory_jobs(session_id,turn_number,payload,status,attempts,error,lease_token,lease_expires_at,next_attempt_at,facts_count) VALUES ($1,$2,'{}',$3,3,'synthetic failure',$4,'2000-01-01','2099-01-01',7) RETURNING id", [sessions[label], turn, status, token]);
          const node = randomUUID();
          await pool.query("INSERT INTO memory_nodes(id,session_id,layer,category,title,content) VALUES ($1,$2,'semantic','world','Fixture','Fixture')", [node, sessions[label]]);
          const vector = await pool.query("INSERT INTO memory_embeddings(memory_node_id,session_id,model,dims,content_hash,status,attempts,error,lease_token,lease_expires_at,next_attempt_at,vector) VALUES ($1,$2,'gemini-embedding-2',128,'keep-hash',$3,3,'synthetic failure',$4,'2000-01-01','2099-01-01',ARRAY[1.0,0.5]::real[]) RETURNING id", [node, sessions[label], status, token]);
          if (label === "A" && status === "failed") { failedJobs.push(job.rows[0].id); failedVectors.push(vector.rows[0].id); }
        }
      }
      const untouched = async () => ({
        jobs: (await independent.query("SELECT to_jsonb(j) AS row FROM memory_jobs j WHERE NOT(id=ANY($1::uuid[])) ORDER BY id", [failedJobs])).rows,
        embeddings: (await independent.query("SELECT to_jsonb(e) AS row FROM memory_embeddings e WHERE NOT(id=ANY($1::uuid[])) ORDER BY id", [failedVectors])).rows,
        nodes: (await independent.query("SELECT to_jsonb(n) AS row FROM memory_nodes n ORDER BY id")).rows,
        quotas: (await independent.query("SELECT to_jsonb(q) AS row FROM model_call_quotas q ORDER BY owner_id,scope,model,day")).rows,
        logs: (await independent.query("SELECT to_jsonb(l) AS row FROM token_logs l ORDER BY id")).rows,
      });
      const before = await untouched();
      const { POST } = await import("../../src/app/api/system/process/route");
      process.env.CHRONICLE_ADMIN_ACCOUNT_IDS = accountA.identity.account!.id;
      const lower = (await independent.query("SELECT clock_timestamp() AS now")).rows[0].now as Date;
      const invoke = () => cookieContext(`chronicle_guest=${accountA.guestToken}; chronicle_session=${accountA.sessionToken}`, () => POST(new Request("https://queue.test/api/system/process", { method: "POST", headers: { origin: "https://queue.test", "content-type": "application/json" }, body: '{"action":"retry"}' })));
      const response = await invoke();
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, queued: 2 });
      const upper = (await independent.query("SELECT clock_timestamp() AS now")).rows[0].now as Date;
      const reset = (await independent.query("SELECT status,attempts,error,lease_token,lease_expires_at,next_attempt_at AT TIME ZONE 'UTC' AS next_attempt_at,updated_at AT TIME ZONE 'UTC' AS updated_at,facts_count FROM memory_jobs WHERE id=$1", [failedJobs[0]])).rows[0];
      assert.deepEqual({ ...reset, next_attempt_at: undefined, updated_at: undefined }, { status: "pending", attempts: 0, error: null, lease_token: null, lease_expires_at: null, next_attempt_at: undefined, updated_at: undefined, facts_count: 7 });
      const vector = (await independent.query("SELECT status,attempts,error,lease_token,lease_expires_at,next_attempt_at AT TIME ZONE 'UTC' AS next_attempt_at,updated_at AT TIME ZONE 'UTC' AS updated_at,content_hash,vector FROM memory_embeddings WHERE id=$1", [failedVectors[0]])).rows[0];
      assert.deepEqual({ ...vector, next_attempt_at: undefined, updated_at: undefined }, { status: "pending", attempts: 0, error: "", lease_token: null, lease_expires_at: null, next_attempt_at: undefined, updated_at: undefined, content_hash: "keep-hash", vector: [1, .5] });
      for (const row of [reset, vector]) {
        assert.ok(row.next_attempt_at.getTime() >= lower.getTime() - 1 && row.next_attempt_at.getTime() <= upper.getTime());
        assert.equal(row.next_attempt_at.getTime(), row.updated_at.getTime());
      }
      assert.deepEqual(await untouched(), before, "admin role cannot reset B or disturb ready/completed/pending rows, canonical memory, quota or telemetry");
      const replay = await invoke();
      assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), { ok: true, queued: 0 });
      assert.deepEqual(await untouched(), before);
      assert.equal((await independent.query("SELECT count(*)::int n FROM owner_activity")).rows[0].n, 0);
    });
  } finally {
    delete process.env.CHRONICLE_ADMIN_ACCOUNT_IDS;
    delete process.env.CHRONICLE_SECRET_ACTIVE_KEY;
    delete process.env.CHRONICLE_SECRET_KEYS;
    try {
      await Promise.all(workers.map(worker => worker.close()));
      await Promise.all(pools.map(pool => pool.end()));
      if (createdSchema) {
        await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`);
        assert.equal((await bootstrap.query("SELECT count(*)::int n FROM pg_namespace WHERE nspname=$1", [schema])).rows[0].n, 0);
        t.diagnostic("Cleanup verified: owned worker processes exited, SQL pools ended, random fixture schema absent");
      }
    } finally { await bootstrap.end(); }
  }
});
