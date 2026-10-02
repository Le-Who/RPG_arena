import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createStartupMigrationRunner } from "../src/lib/startup-migration-runner";
import { register } from "../src/instrumentation";

test("concurrent startup calls share migration work and successful work is not repeated", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const run = createStartupMigrationRunner(async () => { calls++; await gate; });
  const first = run();
  const second = run();
  await Promise.resolve();
  assert.equal(calls, 1);
  let ready = false;
  void second.then(() => { ready = true; });
  assert.equal(ready, false);
  release();
  await Promise.all([first, second]);
  await run();
  assert.equal(calls, 1);
});

test("startup migration errors reject readiness without leaking details and allow a later retry", async () => {
  let calls = 0;
  const run = createStartupMigrationRunner(async () => { if (++calls === 1) throw new Error("synthetic-secret-connection-detail"); });
  await assert.rejects(run(), error => error instanceof Error && error.message === "STARTUP_MIGRATION_FAILED" && !("cause" in error));
  await run();
  assert.equal(calls, 2);
});

test("instrumentation never initializes DB for disabled migration or non-Node runtime", async () => {
  const previous = { runtime: process.env.NEXT_RUNTIME, flag: process.env.CHRONICLE_AUTO_MIGRATE, url: process.env.DATABASE_URL };
  try {
    delete process.env.DATABASE_URL;
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.CHRONICLE_AUTO_MIGRATE = "0";
    await register();
    process.env.NEXT_RUNTIME = "edge";
    process.env.CHRONICLE_AUTO_MIGRATE = "1";
    await register();
  } finally {
    for (const [name, value] of [["NEXT_RUNTIME", previous.runtime], ["CHRONICLE_AUTO_MIGRATE", previous.flag], ["DATABASE_URL", previous.url]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test("failed opt-in startup terminates even when the framework catches rejected preparation", async () => {
  await assert.rejects(promisify(execFile)(process.execPath, ["--import", "tsx", "--eval",
    "require('./src/instrumentation').register().then(()=>console.log('UNEXPECTED_READY')).catch(()=>{});setInterval(()=>{},1000)",
  ], {
    env: { ...process.env, DATABASE_URL: "postgresql://test:test@127.0.0.1:1/chronicle_test", NEXT_RUNTIME: "nodejs", CHRONICLE_AUTO_MIGRATE: "1" },
    timeout: 5000,
  }), error => {
    const result = error as Error & { code?: number; stdout?: string; stderr?: string };
    return result.code === 1 && !result.stdout?.includes("UNEXPECTED_READY") && Boolean(result.stderr?.includes("STARTUP_MIGRATION_FAILED"));
  });
});
