import { createStartupMigrationRunner } from "./startup-migration-runner";

/** Opt-in callers await the same transactional/advisory-locked migration runner as the CLI. */
export const runStartupMigrations = createStartupMigrationRunner(async () => {
  const { pool } = await import("../db");
  const { readMigrationFiles } = await import("drizzle-orm/migrator");
  const { applyMigrations } = await import("../../scripts/lib/apply-migrations");
  const migrations = readMigrationFiles({ migrationsFolder: "./drizzle" });
  const client = await pool.connect();
  try {
    await applyMigrations(client, migrations);
  } finally { client.release(); }
});

/** Kept in the Node-only import: Next can leave its listener alive when preparation merely rejects. */
export async function initializeServerMigrations() {
  try { await runStartupMigrations(); }
  catch {
    console.error("STARTUP_MIGRATION_FAILED: startup stopped; check configuration and run the migration CLI.");
    process.exit(1);
  }
}
