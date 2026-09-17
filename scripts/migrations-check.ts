import assert from "node:assert/strict";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { db, pool } from "../src/db";
import { gameSessions, gameTurns, memoryNodes, memoryEmbeddings, workspacePreferences, inventoryItems } from "../src/db/schema";
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
    for (const table of [gameSessions, gameTurns, memoryNodes, memoryEmbeddings, workspacePreferences, inventoryItems]) await target.select().from(table).limit(1);
    const first = await target.execute(sql`SELECT count(*)::integer AS n FROM drizzle.__drizzle_migrations`);
    assert.equal(first.rows[0].n, 2);
    await migrate(target, { migrationsFolder: "./drizzle" });
    const second = await target.execute(sql`SELECT count(*)::integer AS n FROM drizzle.__drizzle_migrations`);
    assert.equal(second.rows[0].n, 2);
    console.log("PASS: clean PostgreSQL database, complete v2.1 schema, repeat migration is a no-op");
  } finally {
    await targetPool?.end();
    await db.execute(sql.raw(`DROP DATABASE "${name}"`));
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
