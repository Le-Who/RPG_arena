import assert from "node:assert/strict";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { db, pool } from "../src/db";
import { gameSessions, gameTurns, memoryNodes, memoryEmbeddings, workspacePreferences, inventoryItems, turnRequests, memoryJobs, campaignCheckpoints, checkpointForks, workerHeartbeats } from "../src/db/schema";
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
    for (const table of [gameSessions, gameTurns, memoryNodes, memoryEmbeddings, workspacePreferences, inventoryItems, turnRequests, memoryJobs, campaignCheckpoints, checkpointForks, workerHeartbeats]) await target.select().from(table).limit(1);
    const compatibility = await target.execute(sql`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name, column_name) IN (
          ('ai_settings', 'primary_model'),
          ('ai_settings', 'fallback_chain'),
          ('memory_nodes', 'access_count'),
          ('memory_nodes', 'last_accessed_at'),
          ('workspace_preferences', 'reading')
        )
      ORDER BY table_name, column_name
    `);
    assert.deepEqual(
      compatibility.rows.map((row) => `${row.table_name}.${row.column_name}`),
      [
        "ai_settings.fallback_chain",
        "ai_settings.primary_model",
        "memory_nodes.access_count",
        "memory_nodes.last_accessed_at",
        "workspace_preferences.reading",
      ],
      "v2.5 must add reading preferences without dropping legacy columns",
    );
    const first = await target.execute(sql`SELECT count(*)::integer AS n FROM drizzle.__drizzle_migrations`);
    assert.equal(first.rows[0].n, 4);
    await migrate(target, { migrationsFolder: "./drizzle" });
    const second = await target.execute(sql`SELECT count(*)::integer AS n FROM drizzle.__drizzle_migrations`);
    assert.equal(second.rows[0].n, 4);
    console.log("PASS: clean PostgreSQL database, complete v2.5 schema, repeat migration is a no-op");
  } finally {
    await targetPool?.end();
    await db.execute(sql.raw(`DROP DATABASE "${name}"`));
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
