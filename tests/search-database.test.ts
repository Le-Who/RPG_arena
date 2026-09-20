import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool, PoolClient } from "pg";
import { runSearchQuery } from "../src/lib/search-database";

test("search DB work has a transaction-local timeout and releases its connection", async () => {
  const calls: string[] = [];
  const client = { query: async (q: { text: string }) => { calls.push(q.text); return { rows: [{ ok: true }] }; }, release: (destroy?: boolean) => calls.push(destroy ? "destroy" : "release") };
  const pool = { connect: async () => client } as unknown as Pool;
  const result = await runSearchQuery(pool, { text: "SELECT 1", values: [] }, Date.now() + 1000);
  assert.deepEqual(result, [{ ok: true }]);
  assert.match(calls[0], /^BEGIN; SET LOCAL statement_timeout = '\d+ms'$/);
  assert.deepEqual(calls.slice(1), ["SELECT 1", "COMMIT", "release"]);
});

test("failed queries destroy connections and do not retry unbounded legacy scans", async () => {
  let destroyed = false;
  const client = { query: async (q: { text: string }) => { if (q.text === "fail") throw new Error("statement timeout"); return { rows: [] }; }, release: (destroy?: boolean) => { destroyed = destroy === true; } };
  const pool = { connect: async () => client } as unknown as Pool;
  await assert.rejects(runSearchQuery(pool, { text: "fail", values: [] }, Date.now() + 1000), /statement timeout/);
  assert.equal(destroyed, true);
});

test("pool acquisition is bounded and late connections are released", async () => {
  let finish!: (client: PoolClient) => void;
  let released = false;
  const pool = { connect: () => new Promise<PoolClient>(resolve => { finish = resolve; }) } as unknown as Pool;
  const running = runSearchQuery(pool, { text: "SELECT 1", values: [] }, Date.now() + 15);
  await assert.rejects(running, /MEMORY_SEARCH_TIMEOUT/);
  finish({ release: () => { released = true; } } as unknown as PoolClient);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(released, true);
});
