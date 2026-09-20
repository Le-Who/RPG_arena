import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { memorySearchDb, insertMemory, sessionId, model, queryVector } from "./helpers/memory-search-db";
import { pool } from "../src/db";
import { searchMemory } from "../src/lib/embeddings";
import { queryVectorCache } from "../src/lib/query-vectors";
import { hashContent } from "../src/lib/memory";

test("retrieval uses SQL after migration, uses old reader before migration, and never falls back on SQL failure", async () => {
  const pg = await memorySearchDb();
  let destroyed = 0, legacyReads = 0;
  let failSearch = false;
  const run = async (config: { text: string; values?: unknown[]; rowMode?: string }) => {
    if (config.text.startsWith("BEGIN;") || config.text === "COMMIT") { await pg.exec(config.text); return { rows: [] }; }
    if (failSearch && config.text.startsWith("WITH valid")) throw new Error("simulated statement timeout");
    if (config.text.startsWith("SELECT jsonb_build_object")) legacyReads++;
    const result = await pg.query(config.text, config.values);
    return { ...result, rows: config.rowMode === "array" ? result.rows.map(row => result.fields.map(f => (row as Record<string, unknown>)[f.name])) : result.rows };
  };
  const connect = mock.method(pool, "connect", async () => ({ query: run, release: (destroy: boolean) => { if (destroy) destroyed++; } }) as never);
  const fetch = mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected provider call"); });
  try {
    // Empty campaigns do not spend a provider request.
    const empty = await searchMemory({ sessionId, model, dims: 768, keys: [], query: "empty" });
    assert.equal(empty.backend, "postgres");
    assert.deepEqual(empty.results, []);
    await insertMemory(pg, 2, 768, { stale: true });
    await insertMemory(pg, 3, 768, { values: null });
    assert.deepEqual((await searchMemory({ sessionId, model, dims: 768, keys: [], query: "no valid embeddings" })).results, []);
    const id = await insertMemory(pg, 1, 768);
    const queryText = "cached synthetic query";
    const key = hashContent(sessionId, model, "768", queryText);
    await queryVectorCache.prewarm([key], async () => [queryVector(768)]);
    const opts = { sessionId, model, dims: 768, keys: ["dummy"], query: queryText };
    const sqlResult = await searchMemory(opts);
    assert.equal(sqlResult.backend, "postgres");
    assert.equal(sqlResult.results[0].id, id);
    assert.equal(legacyReads, 0);
    failSearch = true;
    await assert.rejects(searchMemory(opts), /simulated statement timeout/);
    assert.equal(destroyed, 1);
    assert.equal(legacyReads, 0);
    await pg.exec("ROLLBACK"); // fake pool destruction does not close this shared test database
    failSearch = false;
    await pg.exec("DROP FUNCTION chronicle_memory_vector(real[],integer); DROP FUNCTION chronicle_embedding_hash(text,integer,text,text)");
    const legacyResult = await searchMemory(opts);
    assert.equal(legacyResult.backend, "legacy");
    assert.equal(legacyResult.results[0].id, id);
    assert.equal(legacyReads, 1);
    await pg.exec(await readFile("drizzle/0006_database_memory_search.sql", "utf8"));
    assert.equal((await searchMemory(opts)).backend, "postgres", "migration becomes visible without restarting the app");
    assert.equal(fetch.mock.callCount(), 0);
  } finally {
    connect.mock.restore(); fetch.mock.restore();
    await pg.close();
  }
});
