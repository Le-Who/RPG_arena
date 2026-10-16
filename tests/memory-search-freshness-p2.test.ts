import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { pool } from "../src/db";
import { searchMemory } from "../src/lib/embeddings";
import { hashContent } from "../src/lib/memory";
import { queryVectorCache } from "../src/lib/query-vectors";
import { memorySearchDb, insertMemory, sessionId, otherSessionId, model, queryVector, documentVector, embeddingHash } from "./helpers/memory-search-db";

// Only the external pg transport is replaced: availability checks, transactions,
// migration functions, pgvector distances and ranking execute in the real engine.
async function withSearchDb(run: (pg: PGlite) => Promise<void>) {
  const pg = await memorySearchDb();
  const connect = mock.method(pool, "connect", async () => ({
    query: async (config: { text: string; values?: unknown[] }) => {
      if (config.text.startsWith("BEGIN;") || config.text === "COMMIT") {
        await pg.exec(config.text);
        return { rows: [] };
      }
      return pg.query(config.text, config.values);
    },
    release: () => {},
  }) as never);
  const fetch = mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected embedding provider fetch"); });
  try {
    await run(pg);
    assert.equal(fetch.mock.callCount(), 0, "cached query vectors must not require another embedding fetch");
  } finally {
    connect.mock.restore();
    fetch.mock.restore();
    await pg.close();
  }
}

async function warm(query: string, ownerSession = sessionId, dims = 768, vector = queryVector(dims)) {
  await queryVectorCache.prewarm([hashContent(ownerSession, model, String(dims), query)], async () => [vector]);
}

test("actual searchMemory rereads importance, turn and reembedded content while reusing the same cached query vector", async () => {
  await withSearchDb(async pg => {
    await insertMemory(pg, 21, 768, { importance: 20, turnTo: 40, content: "Мария оставила письмо в библиотеке." });
    await insertMemory(pg, 22, 768, { importance: 10, turnTo: 40, content: "Встреча назначена у старого моста." });
    const query = "p2 cached query freshness";
    await warm(query);
    const opts = { sessionId, model, dims: 768, keys: [], query, currentTurn: 100 };
    const initial = await searchMemory(opts);
    assert.equal(initial.backend, "postgres");
    assert.deepEqual(initial.results.map(n => n.id), [
      "10000000-0000-4000-8000-000000000021", "10000000-0000-4000-8000-000000000022",
    ]);
    assert.equal(initial.candidates, 2);

    await pg.query("UPDATE memory_nodes SET importance=100 WHERE id=$1", ["10000000-0000-4000-8000-000000000022"]);
    const important = await searchMemory(opts);
    assert.deepEqual(important.results.map(n => n.id), [
      "10000000-0000-4000-8000-000000000022", "10000000-0000-4000-8000-000000000021",
    ]);
    assert.equal(important.results[0].importance, 100);

    await pg.exec("UPDATE memory_nodes SET importance=50; UPDATE memory_nodes SET turn_to=100 WHERE id='10000000-0000-4000-8000-000000000021'");
    assert.deepEqual((await searchMemory(opts)).results.map(n => n.id), [
      "10000000-0000-4000-8000-000000000021", "10000000-0000-4000-8000-000000000022",
    ]);
    await pg.exec("UPDATE memory_nodes SET turn_to=50 WHERE id='10000000-0000-4000-8000-000000000021'; UPDATE memory_nodes SET turn_to=110 WHERE id='10000000-0000-4000-8000-000000000022'");
    const recent = await searchMemory({ ...opts, currentTurn: 110 });
    assert.deepEqual(recent.results.map(n => n.id), [
      "10000000-0000-4000-8000-000000000022", "10000000-0000-4000-8000-000000000021",
    ]);
    assert.equal(recent.results[0].turnTo, 110);
    assert.deepEqual((await searchMemory({ ...opts, currentTurn: 0 })).results.map(n => n.id), [
      "10000000-0000-4000-8000-000000000021", "10000000-0000-4000-8000-000000000022",
    ]);

    // A text edit does not make the old document vector describe the new text.
    await pg.query("UPDATE memory_nodes SET content=$1 WHERE id=$2", ["Встреча перенесена в городскую библиотеку.", "10000000-0000-4000-8000-000000000022"]);
    const stale = await searchMemory(opts);
    assert.deepEqual(stale.results.map(n => n.id), ["10000000-0000-4000-8000-000000000021"]);
    assert.equal(stale.candidates, 1);
    assert.equal(stale.results[0].content, "Мария оставила письмо в библиотеке.");
    await pg.query("UPDATE memory_embeddings SET status='pending', content_hash=$1, vector=NULL WHERE memory_node_id=$2", [embeddingHash("Memory 22", "Встреча перенесена в городскую библиотеку.", 768), "10000000-0000-4000-8000-000000000022"]);
    assert.deepEqual((await searchMemory(opts)).results.map(n => n.id), ["10000000-0000-4000-8000-000000000021"]);
    await pg.query("UPDATE memory_embeddings SET status='ready', vector=$1::real[] WHERE memory_node_id=$2", [documentVector(768, .4), "10000000-0000-4000-8000-000000000022"]);
    const refreshed = await searchMemory(opts);
    assert.deepEqual(refreshed.results.map(n => n.id), [
      "10000000-0000-4000-8000-000000000021", "10000000-0000-4000-8000-000000000022",
    ]);
    assert.equal(refreshed.candidates, 2);
    assert.equal(refreshed.results[1].content, "Встреча перенесена в городскую библиотеку.");
    assert.ok(Math.abs(refreshed.results[1].similarity - .4) < 1e-6);
  });
});

test("actual searchMemory resolves equal scores by UUID before layer caps and global limits", async () => {
  await withSearchDb(async pg => {
    // Reverse insertion order deliberately disagrees with UUID order.
    await insertMemory(pg, 34, 768);
    await insertMemory(pg, 33, 768);
    await insertMemory(pg, 32, 768);
    await insertMemory(pg, 31, 768, { layer: "episodic" });
    const query = "p2 UUID ties";
    await warm(query);
    const opts = { sessionId, model, dims: 768, keys: [], query, k: 3, perLayerCap: 1 };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await searchMemory(opts);
      assert.deepEqual(result.results.map(n => n.id), [
        "10000000-0000-4000-8000-000000000031", "10000000-0000-4000-8000-000000000032",
      ]);
      assert.equal(result.candidates, 4);
    }
    assert.deepEqual((await searchMemory({ ...opts, k: 1 })).results.map(n => n.id), ["10000000-0000-4000-8000-000000000031"]);
  });
});

test("actual searchMemory filters similarity before selection and applies layer caps after weighted ranking", async () => {
  await withSearchDb(async pg => {
    await insertMemory(pg, 51, 768, { similarity: .99, importance: 0, salience: 0 });
    await insertMemory(pg, 52, 768, { similarity: .65, importance: 100, salience: 100 });
    await insertMemory(pg, 53, 768, { similarity: .6, importance: 0, salience: 0, layer: "episodic" });
    await insertMemory(pg, 54, 768, { similarity: .49, importance: 100, salience: 100, layer: "episodic" });
    const query = "p2 ranking then diversity";
    await warm(query);
    const result = await searchMemory({ sessionId, model, dims: 768, keys: [], query, currentTurn: 100, minSimilarity: .5, perLayerCap: 1, k: 2 });
    // Hand-checked scores: 52=.8075, 51=.7445, 53=.53; 54 is below .5.
    assert.deepEqual(result.results.map(n => n.id), [
      "10000000-0000-4000-8000-000000000052", "10000000-0000-4000-8000-000000000053",
    ]);
    assert.equal(result.candidates, 3);
    assert.ok(Math.abs(result.results[0].score - .8075) < 1e-6);
    assert.ok(Math.abs(result.results[1].score - .53) < 1e-6);
  });
});

test("actual searchMemory keeps cached queries and results scoped to session and vector space", async () => {
  await withSearchDb(async pg => {
    const vertical = Array.from({ length: 768 }, (_, i) => i === 1 ? 1 : 0);
    await insertMemory(pg, 61, 768, { values: queryVector(768) });
    await insertMemory(pg, 62, 768, { values: vertical });
    await insertMemory(pg, 63, 768, { session: otherSessionId, values: queryVector(768) });
    await insertMemory(pg, 64, 768, { session: otherSessionId, values: vertical });
    await insertMemory(pg, 65, 768, { embeddingSession: otherSessionId, values: queryVector(768) });
    await insertMemory(pg, 66, 768, { session: otherSessionId, embeddingSession: sessionId, values: queryVector(768) });
    await insertMemory(pg, 67, 768, { embeddingModel: "gemini-embedding-001", values: queryVector(768) });
    await insertMemory(pg, 68, 1536, { values: queryVector(1536) });
    const query = "p2 same query across vector spaces";
    await warm(query);
    await warm(query, otherSessionId, 768, vertical);
    await warm(query, sessionId, 1536);
    const opts = { sessionId, model, dims: 768, keys: [], query };
    assert.deepEqual((await searchMemory(opts)).results.map(n => n.id), ["10000000-0000-4000-8000-000000000061"]);
    assert.deepEqual((await searchMemory({ ...opts, sessionId: otherSessionId })).results.map(n => n.id), ["10000000-0000-4000-8000-000000000064"]);
    assert.deepEqual((await searchMemory({ ...opts, dims: 1536 })).results.map(n => n.id), ["10000000-0000-4000-8000-000000000068"]);
    assert.deepEqual((await searchMemory(opts)).results.map(n => n.id), ["10000000-0000-4000-8000-000000000061"]);
  });
});

test("rolling deployment legacy search uses the same UUID tie order before layer and result limits", async () => {
  await withSearchDb(async pg => {
    await insertMemory(pg, 82, 768);
    await insertMemory(pg, 81, 768);
    await insertMemory(pg, 80, 768, { layer: "episodic" });
    const query = "p2 rolling deployment equal scores";
    await warm(query);
    await pg.exec("DROP FUNCTION chronicle_memory_vector(real[],integer); DROP FUNCTION chronicle_embedding_hash(text,integer,text,text)");
    const opts = { sessionId, model, dims: 768, keys: [], query, perLayerCap: 1, k: 2 };
    const legacy = await searchMemory(opts);
    assert.equal(legacy.backend, "legacy");
    assert.deepEqual(legacy.results.map(n => n.id), [
      "10000000-0000-4000-8000-000000000080", "10000000-0000-4000-8000-000000000081",
    ]);
    assert.equal(legacy.candidates, 3);
    assert.deepEqual((await searchMemory({ ...opts, k: 1 })).results.map(n => n.id), ["10000000-0000-4000-8000-000000000080"]);
    await pg.exec(await readFile(new URL("../drizzle/0006_database_memory_search.sql", import.meta.url), "utf8"));
    const migrated = await searchMemory(opts);
    assert.equal(migrated.backend, "postgres");
    assert.deepEqual(migrated.results.map(n => n.id), [
      "10000000-0000-4000-8000-000000000080", "10000000-0000-4000-8000-000000000081",
    ]);
  });
});
