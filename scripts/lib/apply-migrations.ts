import type { MigrationMeta } from "drizzle-orm/migrator";

type MigrationClient = {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
};

/** Drizzle's journal/ledger format, with the lock acquired before ledger discovery.
 * One transaction pins the connection even through Neon transaction pooling.
 */
export async function applyMigrations(client: MigrationClient, migrations: MigrationMeta[]) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '120s'");
    await client.query("SET LOCAL statement_timeout = '300s'");
    await client.query("SELECT pg_advisory_xact_lock(724193, 1)");
    await client.query("CREATE SCHEMA IF NOT EXISTS drizzle");
    await client.query("CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)");
    const result = await client.query("SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1");
    const latest = (result.rows[0] as { created_at: string | number } | undefined)?.created_at;
    let applied = 0;
    for (const migration of migrations) {
      if (latest !== undefined && migration.folderMillis <= Number(latest)) continue;
      for (const statement of migration.sql) if (statement.trim()) await client.query(statement);
      await client.query("INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)", [migration.hash, migration.folderMillis]);
      applied++;
    }
    await client.query("COMMIT");
    return applied;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
