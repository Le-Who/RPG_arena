import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { applyMigrations } from "../scripts/lib/apply-migrations";
import { checkReadiness, readinessResponse } from "../src/lib/readiness";

test("database reachability alone does not report a fresh empty database ready", async () => {
  const pg = new PGlite();
  try {
    const state = await checkReadiness((text, values) => pg.query(text, values));
    assert.deepEqual(state, { ok: false, database: true, schema: false, memorySearch: false });
    const response = readinessResponse(state);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false });
  } finally { await pg.close(); }
});

test("readiness requires the shipped migration and working vector/hash functions", async () => {
  const pg = new PGlite({ extensions: { vector, pgcrypto } });
  const query = (text: string, values?: unknown[]) => pg.query<Record<string, unknown>>(text, values);
  const migrationClient = { query: async (text: string, values?: unknown[]) => values ? pg.query(text, values) : (await pg.exec(text)).at(-1)! };
  try {
    const migrations = readMigrationFiles({ migrationsFolder: "./drizzle" });
    await applyMigrations(migrationClient, migrations);
    const ready = await checkReadiness(query);
    assert.deepEqual(ready, { ok: true, database: true, schema: true, memorySearch: true });
    assert.equal(readinessResponse(ready).status, 200);
    const latest = migrations.at(-1)!;
    await pg.query("DELETE FROM drizzle.__drizzle_migrations WHERE created_at=$1", [latest.folderMillis]);
    assert.equal((await checkReadiness(query)).schema, false);
    await pg.query("INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)", [latest.hash, latest.folderMillis]);
    await pg.exec("DROP FUNCTION chronicle_embedding_hash(text, integer, text, text)");
    const missing = await checkReadiness(query);
    assert.equal(missing.ok, false);
    assert.equal(missing.schema, true);
    assert.equal(missing.memorySearch, false);
    await pg.exec("CREATE FUNCTION chronicle_embedding_hash(text,integer,text,text) RETURNS text LANGUAGE sql AS $$ SELECT 'broken'::text $$");
    assert.equal((await checkReadiness(query)).memorySearch, false, "function existence alone is insufficient");
    await pg.exec("DROP TABLE world_locations");
    assert.equal((await checkReadiness(query)).schema, false, "a current ledger does not excuse a missing application table");
  } finally { await pg.close(); }
});

test("health response hides internal capabilities and connection failures", async () => {
  const state = await checkReadiness(async () => { throw new Error("synthetic-connection-secret"); });
  const response = readinessResponse(state);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), '{"ok":false}');
  assert.equal(state.database, false);
});
