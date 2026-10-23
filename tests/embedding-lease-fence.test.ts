import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountsDb } from "./helpers/accounts-db";
import { enqueueEmbeddings, indexPendingEmbeddings } from "../src/lib/embeddings";
import { EMBEDDING_MODEL } from "../src/lib/vector";

async function fixture() {
  const f = await accountsDb();
  const sessionId = randomUUID(), memoryId = randomUUID(), ownerId = `embedding-owner-${sessionId}`;
  await f.pg.query("INSERT INTO ai_settings(id,enforce_limits) VALUES ($1,false)", [ownerId]);
  await f.pg.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,$2,'Embedding lease','{}','{}')", [sessionId, ownerId]);
  await f.pg.query("INSERT INTO memory_nodes(id,session_id,layer,category,title,content) VALUES ($1,$2,'semantic','event','Встреча','Лена ждёт героя у причала.')", [memoryId, sessionId]);
  await enqueueEmbeddings(sessionId, [memoryId], EMBEDDING_MODEL, 128);
  const runIndex = () => indexPendingEmbeddings({ sessionId, keys: ["synthetic-embedding-key"], model: EMBEDDING_MODEL, dims: 128 });
  return { ...f, sessionId, runIndex };
}

// A matching token alone does not authorize an expired worker. Neither late
// vectors nor provider errors may acknowledge or reschedule its expired claim.
for (const ok of [true, false]) test(`expired embedding claim rejects late provider ${ok ? "success" : "failure"}`, async () => {
  const f = await fixture();
  const transport = mock.method(globalThis, "fetch", async () => {
    await f.pg.query("UPDATE memory_embeddings SET lease_expires_at='2000-01-01' WHERE session_id=$1", [f.sessionId]);
    return ok ? Response.json({ embedding: { values: [1, ...Array<number>(127).fill(0)] } }) : new Response("Unavailable", { status: 503 });
  });
  try {
    assert.deepEqual(await f.runIndex(), { indexed: 0, failed: 0, pending: 1 });
    assert.deepEqual((await f.pg.query("SELECT status,attempts,vector,error,lease_token IS NOT NULL AS claimed FROM memory_embeddings WHERE session_id=$1", [f.sessionId])).rows,
      [{ status: "processing", attempts: 1, vector: null, error: "", claimed: true }]);
  } finally { transport.mock.restore(); await f.close(); }
});

test("a fresh embedding claim completes under a non-UTC database timezone", async () => {
  const f = await fixture();
  const vector = [1, ...Array<number>(127).fill(0)];
  const transport = mock.method(globalThis, "fetch", async () => Response.json({ embedding: { values: vector } }));
  try {
    await f.pg.exec("SET TIME ZONE 'Asia/Tokyo'");
    assert.deepEqual(await f.runIndex(), { indexed: 1, failed: 0, pending: 0 });
    assert.deepEqual((await f.pg.query("SELECT status,attempts,vector,error,lease_token,lease_expires_at FROM memory_embeddings WHERE session_id=$1", [f.sessionId])).rows,
      [{ status: "ready", attempts: 1, vector, error: "", lease_token: null, lease_expires_at: null }]);
  } finally { transport.mock.restore(); await f.close(); }
});

test("embedding completion checks lease expiry when delayed SQL executes", async () => {
  const f = await fixture();
  const { pool } = await import("../src/db");
  const transport = mock.method(globalThis, "fetch", async () => Response.json({ embedding: { values: [1, ...Array<number>(127).fill(0)] } }));
  let enter!: () => void, release!: () => void, pending: ReturnType<typeof f.runIndex> | undefined;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const resumed = new Promise<void>(resolve => { release = resolve; });
  const query = mock.method(pool, "query", (async (...args: Parameters<typeof f.run>) => {
    const sql = typeof args[0] === "string" ? args[0] : args[0].text;
    if (sql.startsWith('update "memory_embeddings" set') && !sql.includes('"next_attempt_at"')) {
      // Drizzle has already built any client timestamp predicate. Let that
      // timestamp precede the lease, but execute only after the lease expires.
      await f.pg.query("UPDATE memory_embeddings SET lease_expires_at=clock_timestamp()+interval '50 milliseconds' WHERE session_id=$1", [f.sessionId]);
      enter(); await resumed;
    }
    return f.run(...args);
  }) as never);
  try {
    pending = f.runIndex();
    await entered;
    await new Promise(resolve => setTimeout(resolve, 100));
    release();
    assert.deepEqual(await pending, { indexed: 0, failed: 0, pending: 1 });
    assert.deepEqual((await f.pg.query("SELECT status,vector FROM memory_embeddings WHERE session_id=$1", [f.sessionId])).rows, [{ status: "processing", vector: null }]);
  } finally { release(); await pending?.catch(() => {}); query.mock.restore(); transport.mock.restore(); await f.close(); }
});
