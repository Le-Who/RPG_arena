/** Disposable DATABASE_URL required. Every provider call is intercepted in this process. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../src/db";
import { runMemoryCycle } from "../src/lib/background";
import { enqueueEmbeddings } from "../src/lib/embeddings";

const owners = ["worker-smoke:" + randomUUID(), "worker-smoke:" + randomUUID()];
const ids = [randomUUID(), randomUUID()];
const nodes = [randomUUID(), randomUUID()];
const keys = ["fake-worker-owner-A", "fake-worker-owner-B"];
const nativeFetch = globalThis.fetch;
const observed: { key: string | null; text: string; dims: number }[] = [];
async function run() {
  globalThis.fetch = async (input, init) => {
    assert.ok(String(input).startsWith("https://generativelanguage.googleapis.com/"), "Unexpected outbound request blocked");
    const body = JSON.parse(String(init?.body));
    const requests = body.requests ?? [body];
    const key = new Headers(init?.headers).get("x-goog-api-key");
    const embeddings = requests.map((request: { outputDimensionality: number; content: { parts: { text: string }[] } }) => {
      observed.push({ key, text: request.content.parts[0].text, dims: request.outputDimensionality });
      return { values: Array.from({ length: request.outputDimensionality }, (_, i) => i === 0 ? 1 : 0) };
    });
    return Response.json(body.requests ? { embeddings } : { embedding: embeddings[0] });
  };
  for (let i = 0; i < 2; i++) {
    await pool.query("insert into ai_settings(id,keys,use_live_ai,embeddings_enabled,semantic_extraction_enabled,embedding_dims) values($1,$2,false,true,false,$3)", [owners[i], JSON.stringify([keys[i]]), i === 0 ? 128 : 256]);
    await pool.query("insert into game_sessions(id,owner_id,title,character,world_state) values($1,$2,'Worker isolation fixture','{}','{}')", [ids[i], owners[i]]);
    await pool.query("insert into memory_nodes(id,session_id,layer,category,title,content) values($1,$2,'semantic','world',$3,$3)", [nodes[i], ids[i], `Private worker material ${i}`]);
    await enqueueEmbeddings(ids[i], [nodes[i]], "gemini-embedding-2", i === 0 ? 128 : 256);
  }
  await assert.rejects(runMemoryCycle({ sessionId: ids[1], ownerId: owners[0], source: "manual" }), /owner mismatch/);
  assert.equal(observed.length, 0);
  const first = await runMemoryCycle({ ownerId: owners[0], source: "manual" });
  assert.equal(first.indexed, 1); assert.equal(first.failed, 0);
  assert.deepEqual(observed.map(r => r.key), [keys[0]]);
  assert.equal(observed[0].dims, 128); assert.match(observed[0].text, /Private worker material 0/);
  const untouched = await pool.query("select status from memory_embeddings where session_id=$1", [ids[1]]);
  assert.equal(untouched.rows[0].status, "pending", "A manual cycle must not consume B's job");
  const second = await runMemoryCycle({ source: "worker" });
  assert.equal(second.indexed, 1); assert.equal(second.failed, 0);
  assert.deepEqual(observed.map(r => r.key), keys);
  assert.equal(observed[1].dims, 256); assert.match(observed[1].text, /Private worker material 1/);
  const logs = await pool.query("select owner_id,session_id from token_logs where session_id = any($1::uuid[])", [ids]);
  assert.equal(logs.rows.length, 2);
  for (let i = 0; i < 2; i++) assert.equal(logs.rows.find(row => row.session_id === ids[i])?.owner_id, owners[i]);
  console.log("PASS background jobs reject owner mismatch, scope manual selection, use each campaign owner's key/vector settings, and attribute telemetry correctly (all provider calls mocked)");
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  globalThis.fetch = nativeFetch;
  await pool.query("delete from token_logs where session_id = any($1::uuid[])", [ids]);
  await pool.query("delete from game_sessions where id = any($1::uuid[])", [ids]);
  await pool.query("delete from ai_settings where id = any($1::text[])", [owners]);
  await pool.query("delete from worker_heartbeats where id = any($1::text[])", [owners.map(owner => `memory:manual:${owner}`)]);
  await pool.end();
});
