// Explicit isolated PostgreSQL only; never reads .env or accepts a user database URL.
import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

test("native PostgreSQL quota contention and actual transport fetch admission", { skip: process.env.CHRONICLE_RUN_QUOTA_POSTGRES !== "1", timeout: 30000 }, async () => {
  const url = new URL("postgresql://chronicle_test@127.0.0.1:55439/chronicle_auth_test");
  const schema = `quota_task3_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, /^quota_task3_[a-f0-9]{32}$/);
  const bootstrap = new Pool({ connectionString: url.toString() });
  await bootstrap.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set("options", `-csearch_path=${schema},public`);
  process.env.DATABASE_URL = url.toString();
  process.env.CHRONICLE_QUOTA_TIMEZONE = "America/Los_Angeles";
  const { pool } = await import("../../src/db");
  const old = global.fetch;
  try {
    for (const file of (await readdir("drizzle")).filter(x => /^\d{4}_.*\.sql$/.test(x) && !x.startsWith("0006_")).sort()) await pool.query((await readFile(`drizzle/${file}`, "utf8")).replaceAll('"public".', `"${schema}".`));
    const { reserveModelCall, quotaAdmission, quotaUsage } = await import("../../src/lib/quota");
    const { callGeminiWithRotation } = await import("../../src/lib/gemini-transport");
    const base = { ownerId: "contention", scope: "generation" as const, model: "gemini-flash", day: "2026-09-23", cap: 3 };
    const admitted = await Promise.all(Array.from({ length: 12 }, () => reserveModelCall(base)));
    assert.equal(admitted.filter(Boolean).length, 3);
    assert.equal((await quotaUsage(base.ownerId, base.scope, base.day))[base.model], 3);
    for (const change of [{ ownerId: "other" }, { scope: "embedding" as const }, { model: "gemini-lite" }, { day: "2026-09-24" }]) {
      const isolated = await Promise.all(Array.from({ length: 12 }, () => reserveModelCall({ ...base, ...change })));
      assert.equal(isolated.filter(Boolean).length, 3);
    }
    let calls = 0;
    global.fetch = async () => { calls++; return Response.json({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }); };
    const cfg = { ownerId: "fetch-contention", keys: ["synthetic"], limits: { flash: 3, lite: 0 }, enforceLimits: true };
    const opts = { keys: cfg.keys, models: ["gemini-flash"], system: "s", user: "u", beforeAttempt: quotaAdmission(cfg) };
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => callGeminiWithRotation(opts)));
    assert.equal(results.filter(r => r.status === "fulfilled").length, 3);
    assert.equal(calls, 3);
    await assert.rejects(() => callGeminiWithRotation({ ...opts, models: ["gemini-lite"] }), /QUOTA_EXHAUSTED/);
    assert.equal(calls, 3);
    await pool.query(`INSERT INTO token_logs(owner_id,model,task_type,created_at) VALUES ('dst','gemini-flash','narration','2026-11-02 07:59:59'),('dst','gemini-flash','narration','2026-11-02 08:00:00')`);
    assert.equal(await reserveModelCall({ ...base, ownerId: "dst", day: "2026-11-01", cap: 1 }), false);
    assert.equal(await reserveModelCall({ ...base, ownerId: "dst", day: "2026-11-02", cap: 2 }), true);
    assert.equal(await reserveModelCall({ ...base, ownerId: "dst", day: "2026-11-02", cap: 2 }), false);
  } finally {
    global.fetch = old;
    await pool.end();
    await bootstrap.query(`DROP SCHEMA ${schema} CASCADE`);
    await bootstrap.end();
  }
});
