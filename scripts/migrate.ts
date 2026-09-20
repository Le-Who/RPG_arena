import { readMigrationFiles } from "drizzle-orm/migrator";
import { Client } from "pg";
import { applyMigrations } from "./lib/apply-migrations";
async function run() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for deployment migrations");
  const migrations = readMigrationFiles({ migrationsFolder: "./drizzle" });
  const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });
  try {
    await client.connect();
    const applied = await applyMigrations(client, migrations);
    console.log(`Chronicle migrations complete: ${applied} applied, ${migrations.length - applied} already recorded.`);
  } finally { await client.end(); }
}
run().catch((error) => {
  // Avoid printing connection strings, SQL parameters or private DB contents.
  const code = typeof error?.code === "string" ? error.code : "MIGRATION_FAILED";
  console.error(`Chronicle migration failed (${code}). Deployment stopped; check database availability, permissions and migration SQL.`);
  process.exitCode = 1;
});
