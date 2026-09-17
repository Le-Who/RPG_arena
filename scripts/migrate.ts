import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "../src/db";
async function run() {
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Chronicle migrations applied. Re-running is safe: Drizzle tracks the migration ledger.");
}
run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
