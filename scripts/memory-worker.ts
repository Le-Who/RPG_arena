import { pool } from "../src/db";
import { runMemoryCycle, workerHeartbeat } from "../src/lib/background";
import { runStartupMigrations } from "../src/lib/auto-migrate";
let stopping = false;
let started = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
async function run() {
  if (process.env.CHRONICLE_AUTO_MIGRATE === "1") await runStartupMigrations();
  started = true;
  const once = process.argv.includes("--once");
  console.log("Chronicle memory worker · gemini-embedding-2 · bounded leased jobs");
  do {
    try { console.log(JSON.stringify({ at: new Date().toISOString(), ...await runMemoryCycle({ source: "worker" }) })); }
    catch (error) { console.error("Memory tick failed:", error instanceof Error ? error.name : "UnknownError"); if (once) process.exitCode = 1; }
    if (!once && !stopping) for (let i = 0; i < 15 && !stopping; i++) await new Promise((resolve) => setTimeout(resolve, 1000));
    if (once) break;
  } while (!stopping);
}
run().catch((error) => { console.error(error instanceof Error ? error.name : "WorkerError"); process.exitCode = 1; }).finally(async () => { if (started) await workerHeartbeat("worker", "stopped").catch(() => {}); await pool.end(); });
