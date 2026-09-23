import test from "node:test";
import assert from "node:assert/strict";
import { accountsDb } from "./helpers/accounts-db";
import { reserveModelCall, quotaDay, quotaCap, quotaAdmission, quotaUsage } from "../src/lib/quota";
import { callGeminiWithRotation } from "../src/lib/gemini-transport";

test("quota day uses Pacific DST and rejects invalid zones", () => {
  assert.equal(quotaDay(new Date("2026-03-08T07:59:59Z")), "2026-03-07");
  assert.equal(quotaDay(new Date("2026-03-08T08:00:00Z")), "2026-03-08");
  assert.equal(quotaDay(new Date("2026-11-02T07:59:59Z")), "2026-11-01");
  assert.throws(() => quotaDay(new Date(), "invalid/zone"), /QUOTA_TIMEZONE/);
  assert.equal(quotaCap({ keys: ["a", "b"], limits: { flash: 3, lite: 5 } }, "generation", "flash"), 3);
  assert.equal(quotaCap({ keys: ["a", "b"], keysSharedProject: false, limits: { flash: 3, lite: 5 } }, "generation", "flash"), 6);
});

test("real reservations carry legacy UTC logs once, count late logs and isolate budgets", async () => {
  const fixture = await accountsDb();
  try {
    const base = { ownerId: "owner", scope: "generation" as const, model: "gemini-flash", day: "2026-03-08", cap: 3 };
    await fixture.pg.exec(`INSERT INTO token_logs(owner_id,model,task_type,created_at) VALUES
      ('owner','gemini-flash','narration','2026-03-08 07:59:59'),
      ('owner','gemini-flash','narration','2026-03-08 08:00:00');`);
    assert.equal(await reserveModelCall(base), true);
    await fixture.pg.exec(`INSERT INTO token_logs(owner_id,model,task_type,created_at,quota_reserved) VALUES ('owner','gemini-flash','narration','2026-03-08 10:00:00',true)`);
    assert.equal(await reserveModelCall(base), true);
    assert.equal(await reserveModelCall(base), false);
    assert.equal((await quotaUsage("owner", "generation", base.day))[base.model], 3);
    for (const change of [{ ownerId: "other" }, { scope: "embedding" as const }, { model: "gemini-lite" }, { day: "2026-03-09" }]) assert.equal(await reserveModelCall({ ...base, ...change, cap: 1 }), true);
    assert.equal(await reserveModelCall({ ...base, ownerId: "zero", cap: 0 }), false);
    await assert.rejects(() => reserveModelCall({ ...base, cap: NaN }), /QUOTA_CAP/);
    // A delayed pre-upgrade attempt conservatively consumes capacity on the next reservation.
    await fixture.pg.exec(`INSERT INTO token_logs(owner_id,model,task_type,created_at) VALUES ('late','gemini-flash','narration','2026-03-08 10:00:00')`);
    assert.equal(await reserveModelCall({ ...base, ownerId: "late", cap: 3 }), true);
    await fixture.pg.exec(`INSERT INTO token_logs(owner_id,model,task_type,created_at) VALUES ('late','gemini-flash','narration','2026-03-08 11:00:00')`);
    assert.equal(await reserveModelCall({ ...base, ownerId: "late", cap: 3 }), false);
  } finally { await fixture.close(); }
});

test("real quota + transport counts retries, rotation, fallback and no-fetch denial", async () => {
  const fixture = await accountsDb(); const old = global.fetch;
  try {
    const cfg = { ownerId: "transport", keys: ["a", "b"], enforceLimits: true, limits: { flash: 2, lite: 1 } };
    const calls: string[] = [];
    global.fetch = async url => { calls.push(String(url)); return new Response("", { status: 503 }); };
    await assert.rejects(() => callGeminiWithRotation({ keys: cfg.keys, models: ["gemini-lite", "gemini-flash"], system: "s", user: "u", beforeAttempt: quotaAdmission(cfg) }), /QUOTA_EXHAUSTED/);
    assert.equal(calls.length, 3);
    assert.deepEqual(await quotaUsage(cfg.ownerId), { "gemini-lite": 1, "gemini-flash": 2 });
    await assert.rejects(() => callGeminiWithRotation({ keys: cfg.keys, models: ["gemini-lite"], system: "s", user: "u", beforeAttempt: quotaAdmission(cfg) }), /QUOTA_EXHAUSTED/);
    assert.equal(calls.length, 3);
    let offCalls = 0;
    global.fetch = async () => { offCalls++; return Response.json({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }); };
    const result = await callGeminiWithRotation({ keys: cfg.keys, models: ["gemini-lite"], system: "s", user: "u", beforeAttempt: quotaAdmission({ ...cfg, enforceLimits: false }) });
    assert.equal(result.text, "ok");
    assert.equal((await quotaUsage(cfg.ownerId))["gemini-lite"], 2);
    await assert.rejects(() => callGeminiWithRotation({ keys: cfg.keys, models: ["gemini-lite"], system: "s", user: "u", beforeAttempt: quotaAdmission(cfg) }), /QUOTA_EXHAUSTED/);
    assert.equal(offCalls, 1, "turning enforcement back on retains calls made while off");
    // Missing/unavailable ledger must not be mistaken for a retriable provider failure.
    await fixture.pg.exec("ALTER TABLE model_call_quotas RENAME TO unavailable_quotas");
    let unavailableFetches = 0;
    global.fetch = async () => { unavailableFetches++; throw new Error("unexpected fetch"); };
    await assert.rejects(() => callGeminiWithRotation({ keys: cfg.keys, models: ["gemini-lite", "gemini-flash"], system: "s", user: "u", beforeAttempt: quotaAdmission(cfg) }), /QUOTA_UNAVAILABLE/);
    await assert.rejects(() => callGeminiWithRotation({ keys: cfg.keys, models: ["gemini-lite"], system: "s", user: "u", beforeAttempt: quotaAdmission({ ...cfg, enforceLimits: false }) }), /QUOTA_UNAVAILABLE/);
    assert.equal(unavailableFetches, 0);
  } finally { global.fetch = old; await fixture.close(); }
});
