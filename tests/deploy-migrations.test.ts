import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { applyMigrations } from "../scripts/lib/apply-migrations";

test("deployment runner applies full journal, skips replay, and applies future entries", async () => {
  const pg = new PGlite({ extensions: { vector, pgcrypto } });
  const client = { query: async (text: string, values?: unknown[]) => values ? pg.query(text, values) : (await pg.exec(text)).at(-1)! };
  try {
    const migrations = readMigrationFiles({ migrationsFolder: "./drizzle" });
    assert.equal(await applyMigrations(client, migrations), migrations.length);
    assert.equal(await applyMigrations(client, migrations), 0);
    const future = { folderMillis: migrations.at(-1)!.folderMillis + 1, hash: "future-test", bps: true, sql: ["CREATE TABLE future_test(id integer)"] };
    assert.equal(await applyMigrations(client, [...migrations, future]), 1);
    assert.equal((await pg.query("SELECT * FROM future_test")).rows.length, 0);
  } finally { await pg.close(); }
});

test("failed migration rolls back schema and ledger and can be retried", async () => {
  const pg = new PGlite();
  const client = { query: async (text: string, values?: unknown[]) => values ? pg.query(text, values) : (await pg.exec(text)).at(-1)! };
  try {
    const entry = { folderMillis: 1, hash: "test", bps: true, sql: ["CREATE TABLE rollback_test(id integer)", "SELECT missing_column"] };
    await assert.rejects(applyMigrations(client, [entry]), /missing_column/);
    assert.equal((await pg.query<{ name: string | null }>("SELECT to_regclass('rollback_test') AS name")).rows[0].name, null);
    assert.equal(await applyMigrations(client, [{ ...entry, sql: entry.sql.slice(0, 1) }]), 1);
  } finally { await pg.close(); }
});

test("deployment runner locks before reading ledger and rolls back lock failures", async () => {
  const calls: string[] = [];
  const client = { query: async (text: string) => {
    calls.push(text);
    if (text.includes("pg_advisory_xact_lock")) throw new Error("lock timeout");
    return { rows: [] };
  } };
  await assert.rejects(applyMigrations(client, []), /lock timeout/);
  assert.equal(calls[0], "BEGIN");
  assert.equal(calls.at(-1), "ROLLBACK");
  assert.ok(!calls.some(text => text.includes("CREATE SCHEMA") || text.includes("SELECT created_at")));
});
