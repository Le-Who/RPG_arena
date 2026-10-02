import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { sql } from "drizzle-orm";
import { db, pool } from "../src/db";
import { gameSessions, gameTurns, memoryNodes, memoryEmbeddings, workspacePreferences, inventoryItems, turnRequests, memoryJobs, campaignCheckpoints, checkpointForks, workerHeartbeats, visualSettings } from "../src/db/schema";
async function run() {
  // Only use in a disposable development sandbox: requires CREATE DATABASE permission.
  const name = `chronicle_migration_test_${Date.now()}`;
  const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${name}`;
  let targetPool: Pool | undefined;
  await db.execute(sql.raw(`CREATE DATABASE "${name}"`));
  try {
    targetPool = new Pool({ connectionString: url.toString(), max: 2 });
    const target = drizzle(targetPool);
    await migrate(target, { migrationsFolder: "./drizzle" });
    for (const table of [gameSessions, gameTurns, memoryNodes, memoryEmbeddings, workspacePreferences, inventoryItems, turnRequests, memoryJobs, campaignCheckpoints, checkpointForks, workerHeartbeats, visualSettings]) await target.select().from(table).limit(1);
    const compatibility = await target.execute(sql`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name, column_name) IN (
          ('ai_settings', 'primary_model'),
          ('ai_settings', 'fallback_chain'),
          ('memory_nodes', 'access_count'),
          ('memory_nodes', 'last_accessed_at'),
          ('workspace_preferences', 'reading'),
          ('ai_settings', 'typesafe_key'),
          ('ai_settings', 'typesafe_pilot_enabled'),
          ('memory_jobs', 'typesafe_report')
        )
      ORDER BY table_name, column_name
    `);
    assert.deepEqual(
      compatibility.rows.map((row) => `${row.table_name}.${row.column_name}`),
      [
        "ai_settings.fallback_chain",
        "ai_settings.primary_model",
        "ai_settings.typesafe_key",
        "ai_settings.typesafe_pilot_enabled",
        "memory_jobs.typesafe_report",
        "memory_nodes.access_count",
        "memory_nodes.last_accessed_at",
        "workspace_preferences.reading",
      ],
      "v2.7 must add reading preferences and visual schema without dropping legacy columns",
    );
    const first = await target.execute(sql`SELECT count(*)::integer AS n FROM drizzle.__drizzle_migrations`);
    const migrationCount = readMigrationFiles({ migrationsFolder: "./drizzle" }).length;
    assert.equal(first.rows[0].n, migrationCount);
    await migrate(target, { migrationsFolder: "./drizzle" });
    const second = await target.execute(sql`SELECT count(*)::integer AS n FROM drizzle.__drizzle_migrations`);
    assert.equal(second.rows[0].n, migrationCount);

    const legacySchema = `legacy_${Date.now()}`;
    const migrationSql = await readFile("drizzle/0004_typesafe_pilot.sql", "utf8");
    const client = await targetPool.connect();
    try {
      await client.query(`CREATE SCHEMA "${legacySchema}"`);
      await client.query(`SET search_path TO "${legacySchema}"`);
      await client.query("CREATE TABLE ai_settings (id integer PRIMARY KEY)");
      await client.query("CREATE TABLE memory_jobs (id integer PRIMARY KEY)");
      await client.query("INSERT INTO ai_settings (id) VALUES (1); INSERT INTO memory_jobs (id) VALUES (1)");
      await client.query(migrationSql);
      const upgraded = await client.query(`
        SELECT
          (SELECT column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'memory_jobs' AND column_name = 'typesafe_report') AS column_default,
          (SELECT typesafe_report IS NULL FROM memory_jobs WHERE id = 1) AS existing_row_is_sql_null
      `, [legacySchema]);
      assert.equal(upgraded.rows[0].column_default, null, "typesafe_report must not create JSON-null defaults");
      assert.equal(upgraded.rows[0].existing_row_is_sql_null, true, "existing jobs must migrate to SQL NULL");
    } finally {
      client.release();
    }
    console.log("PASS: clean PostgreSQL database, complete v2.7 schema, repeat migration is a no-op");
  } finally {
    await targetPool?.end();
    await db.execute(sql.raw(`DROP DATABASE "${name}"`));
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
