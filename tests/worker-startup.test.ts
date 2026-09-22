import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type WorkerResult = { code: number | null; stdout: string; stderr: string };

async function runStubbedWorker(migrationModule: string): Promise<WorkerResult> {
  const directory = await mkdtemp(join(tmpdir(), "chronicle-worker-startup-"));
  try {
    const db = join(directory, "db.mjs");
    const background = join(directory, "background.mjs");
    const migration = join(directory, "auto-migrate.mjs");
    const preload = join(directory, "preload.mjs");
    await writeFile(db, "export const pool = { async end() { console.log('POOL_END'); } };\n");
    await writeFile(background, [
      "export async function runMemoryCycle() { console.log('TICK'); return { status: 'idle' }; }",
      "export async function workerHeartbeat() { console.log('HEARTBEAT'); }",
    ].join("\n"));
    await writeFile(migration, migrationModule);
    await writeFile(preload, `
      import { registerHooks } from "node:module";
      const redirects = new Map(${JSON.stringify([
        ["../src/db", pathToFileURL(db).href],
        ["../src/lib/background", pathToFileURL(background).href],
        ["../src/lib/auto-migrate", pathToFileURL(migration).href],
      ])});
      registerHooks({
        resolve(specifier, context, nextResolve) {
          const redirected = redirects.get(specifier);
          if (redirected && context.parentURL?.endsWith("/scripts/memory-worker.ts")) {
            return { url: redirected, shortCircuit: true };
          }
          return nextResolve(specifier, context);
        }
      });
    `);

    const child = spawn(process.execPath, [
      "--import", "tsx",
      "--import", pathToFileURL(preload).href,
      "scripts/memory-worker.ts",
      "--once",
    ], {
      cwd: process.cwd(),
      env: { ...process.env, CHRONICLE_AUTO_MIGRATE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", chunk => { stdout += String(chunk); });
    child.stderr?.on("data", chunk => { stderr += String(chunk); });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    clearTimeout(timeout);
    return { code, stdout, stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("SIGTERM during awaited startup closes the pool without starting or heartbeating the worker", async () => {
  const result = await runStubbedWorker(`
    export async function runStartupMigrations() {
      console.log("STARTUP_WAITING");
      await new Promise(resolve => setImmediate(() => {
        process.emit("SIGTERM");
        resolve();
      }));
    }
  `);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /POOL_END/);
  assert.doesNotMatch(result.stdout, /Chronicle memory worker|TICK|HEARTBEAT/);
});

test("startup migration failure logs its safe code instead of the generic error name", async () => {
  const result = await runStubbedWorker(`
    export async function runStartupMigrations() {
      throw new Error("STARTUP_MIGRATION_FAILED");
    }
  `);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /STARTUP_MIGRATION_FAILED/);
  assert.doesNotMatch(result.stdout, /Chronicle memory worker|TICK|HEARTBEAT/);
  assert.match(result.stdout, /POOL_END/);
});
