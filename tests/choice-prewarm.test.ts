import assert from "node:assert/strict";
import test from "node:test";
import { buildMemoryQuery, QueryVectorCache } from "../src/lib/query-vectors";

test("buildMemoryQuery uses the exact action, location and truncated narration identity", () => {
  const narration = "я".repeat(260);
  assert.equal(buildMemoryQuery("  Идти  ", "Башня", narration), `Идти. Локация: Башня. ${"я".repeat(240)}`);
});

test("prewarm batches at most three distinct exact queries", async () => {
  const calls: string[][] = [];
  const cache = new QueryVectorCache({ maxEntries: 128, ttlMs: 120_000 });
  await cache.prewarm(["a", "b", "a", "c", "d"], async texts => {
    calls.push(texts);
    return texts.map((_, i) => [i + 1]);
  }, 3);
  assert.deepEqual(calls, [["a", "b", "c"]]);
  assert.deepEqual(await cache.get("b", async () => { throw new Error("should be cached"); }), [2]);
});

test("cache expires entries and stays bounded", async () => {
  let now = 0;
  let calls = 0;
  const cache = new QueryVectorCache({ maxEntries: 2, ttlMs: 10, now: () => now });
  const load = async (key: string) => { calls++; return [key.charCodeAt(0)]; };
  await cache.get("a", () => load("a"));
  await cache.get("b", () => load("b"));
  await cache.get("c", () => load("c"));
  await cache.get("a", () => load("a"));
  assert.equal(calls, 4, "oldest entry was evicted at the size bound");
  now = 11;
  await cache.get("c", () => load("c"));
  assert.equal(calls, 5, "expired entries are recomputed");
});

test("in-flight prewarm and retrieval coalesce on the exact key", async () => {
  let resolve!: (vectors: number[][]) => void;
  let calls = 0;
  const cache = new QueryVectorCache();
  const batch = cache.prewarm(["same"], async () => {
    calls++;
    return new Promise<number[][]>(r => { resolve = r; });
  });
  await Promise.resolve();
  const retrieval = cache.get("same", async () => { calls++; return [9]; });
  resolve([[4, 2]]);
  assert.deepEqual(await retrieval, [4, 2]);
  await batch;
  assert.equal(calls, 1);
});

test("failed in-flight work is evicted so retrieval can retry", async () => {
  let calls = 0;
  const cache = new QueryVectorCache();
  await assert.rejects(cache.get("x", async () => { calls++; throw new Error("down"); }));
  assert.deepEqual(await cache.get("x", async () => { calls++; return [7]; }), [7]);
  assert.equal(calls, 2);
});

test("retrieval waiting on a failed prewarm retries with its own loader", async () => {
  let reject!: (error: unknown) => void;
  let retrievalCalls = 0;
  const cache = new QueryVectorCache();
  const prewarm = cache.prewarm(["x"], async () => new Promise<number[][]>((_, no) => { reject = no; }));
  await Promise.resolve();
  const retrieval = cache.get("x", async () => { retrievalCalls++; return [8]; });
  reject(new Error("prewarm timed out"));
  await assert.rejects(prewarm);
  assert.deepEqual(await retrieval, [8]);
  assert.equal(retrievalCalls, 1);
});

test("retrieval abandons a hung shared prewarm within its wait budget", async () => {
  let finish!: (vectors: number[][]) => void;
  const cache = new QueryVectorCache();
  const prewarm = cache.prewarm(["x"], () => new Promise<number[][]>(resolve => { finish = resolve; }));
  await Promise.resolve();
  const started = Date.now();
  assert.deepEqual(await cache.get("x", async () => [6], { waitMs: 10 }), [6]);
  assert.ok(Date.now() - started < 200);
  finish([[5]]);
  await prewarm;
});

test("speculative pending admission is bounded", async () => {
  let finish!: (vectors: number[][]) => void;
  const calls: string[][] = [];
  const cache = new QueryVectorCache({ maxPendingEntries: 2 });
  const first = cache.prewarm(["a", "b", "c"], keys => {
    calls.push(keys);
    return new Promise<number[][]>(resolve => { finish = resolve; });
  });
  await Promise.resolve();
  await cache.prewarm(["c", "d"], async keys => { calls.push(keys); return keys.map(() => [1]); });
  assert.deepEqual(calls, [["a", "b"]]);
  finish([[1], [2]]);
  await first;
});

test("vector cache does not cache ranked results", async () => {
  const cache = new QueryVectorCache();
  let rows = [{ id: "old", score: 1 }];
  const search = async () => {
    const vector = await cache.get("q", async () => [1]);
    assert.deepEqual(vector, [1]);
    return [...rows].sort((a, b) => b.score - a.score)[0].id;
  };
  assert.equal(await search(), "old");
  rows = [{ id: "fresh", score: 2 }, { id: "old", score: 1 }];
  assert.equal(await search(), "fresh");
});
