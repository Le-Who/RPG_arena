import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMemorySearchQuery } from "../src/lib/memory-search";
import { memorySearchDb, insertMemory, queryVector, sessionId, otherSessionId, model, embeddingHash } from "./helpers/memory-search-db";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

test("database search preserves weighted ranking, diversity, isolation and vector validity at every supported dimension", async () => {
  const pg = await memorySearchDb();
  try {
    for (const dims of [768, 1536, 3072]) {
      await pg.exec("TRUNCATE memory_nodes, memory_embeddings");
      const strong = await insertMemory(pg, 1, dims, { similarity: .75, importance: 100, salience: 100 });
      await insertMemory(pg, 2, dims, { similarity: .99, importance: 5, salience: 5 });
      const diverse = await insertMemory(pg, 3, dims, { similarity: .8, layer: "episodic" });
      await insertMemory(pg, 4, dims, { session: otherSessionId, importance: 100 });
      await insertMemory(pg, 5, dims, { embeddingSession: otherSessionId });
      await insertMemory(pg, 6, dims, { stale: true });
      await insertMemory(pg, 7, dims, { status: "pending" });
      await insertMemory(pg, 8, dims, { embeddingModel: "gemini-embedding-001" });
      await insertMemory(pg, 9, dims, { values: [1, 0] });
      await insertMemory(pg, 10, dims, { values: Array(dims).fill(0) });
      await insertMemory(pg, 11, dims, { values: null });
      await insertMemory(pg, 12, dims, { similarity: .1 });
      await insertMemory(pg, 13, dims === 768 ? 1536 : 768);
      const query = buildMemorySearchQuery({ sessionId, model, dims, vector: queryVector(dims), currentTurn: 100, k: 8, perLayerCap: 1 });
      const result = (await pg.query<{ results: { id: string; score: number; similarity: number }[]; candidates: number }>(query.text, query.values)).rows[0];
      assert.deepEqual(result.results.map(n => n.id), [strong, diverse]);
      assert.equal(result.candidates, 3);
      assert.ok(Math.abs(result.results[0].score - .8625) < 1e-6);
      assert.ok(!JSON.stringify(result).includes('"vector"'));
      const empty = buildMemorySearchQuery({ sessionId: otherSessionId, model, dims, vector: queryVector(dims), minSimilarity: 1 });
      assert.deepEqual((await pg.query<{ results: unknown[]; candidates: number }>(empty.text, empty.values)).rows[0], { results: [], candidates: 0 });
    }
  } finally { await pg.close(); }
});

test("SQL hash matches existing JS hashes, including UTF-16 truncation and malformed legacy arrays", async () => {
  const pg = await memorySearchDb();
  try {
    for (const [title, content] of [["", "Старое воспоминание"], ["🗝️Ключ", "😀".repeat(4000)], ["X", "a".repeat(5991) + "😀"]]) {
      const result = await pg.query<{ hash: string }>("SELECT chronicle_embedding_hash($1,$2,$3,$4) AS hash", [model, 768, title, content]);
      assert.equal(result.rows[0].hash, embeddingHash(title, content, 768));
    }
    const result = await pg.query("SELECT chronicle_memory_vector(ARRAY[1,'NaN']::real[],2) IS NULL AS nan, chronicle_memory_vector(ARRAY[1,NULL]::real[],2) IS NULL AS missing, chronicle_memory_vector(ARRAY[[1,0]]::real[],2) IS NULL AS matrix");
    assert.deepEqual(result.rows[0], { nan: true, missing: true, matrix: true });
  } finally { await pg.close(); }
});

test("invalid query vectors fail before SQL and query values stay parameterized", () => {
  assert.throws(() => buildMemorySearchQuery({ sessionId, model, dims: 768, vector: [1] }), /INVALID/);
  const query = buildMemorySearchQuery({ sessionId, model: "' OR true --", dims: 768, vector: queryVector(768), k: 500 });
  assert.ok(!query.text.includes("' OR true"));
  assert.ok(query.values.includes(20));
});

test("complete migration ledger applies twice safely and preserves real[] storage", async () => {
  const pg = new PGlite({ extensions: { vector, pgcrypto } });
  try {
    const db = drizzle(pg);
    await migrate(db, { migrationsFolder: "./drizzle" });
    await migrate(db, { migrationsFolder: "./drizzle" });
    const type = await pg.query<{ udt_name: string }>("SELECT udt_name FROM information_schema.columns WHERE table_name='memory_embeddings' AND column_name='vector'");
    assert.equal(type.rows[0].udt_name, "_float4");
    const query = buildMemorySearchQuery({ sessionId, model, dims: 3072, vector: queryVector(3072) });
    assert.deepEqual((await pg.query(query.text, query.values)).rows[0], { results: [], candidates: 0 });
  } finally { await pg.close(); }
});
