import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { accountsDb } from "./helpers/accounts-db";

test("new settings return database defaults in two statements", async () => {
  const fixture = await accountsDb();
  const { pool } = await import("../src/db");
  const { getRawSettingsRow } = await import("../src/lib/ai-settings");
  // A nonstandard database default catches hand-built results that omit persisted values.
  await fixture.pg.exec("ALTER TABLE ai_settings ALTER COLUMN daily_flash_limit SET DEFAULT 73");
  const operations: string[] = [];
  const query = mock.method(pool, "query", async (...args: Parameters<typeof fixture.run>) => {
    const sql = typeof args[0] === "string" ? args[0] : args[0].text;
    operations.push(sql.trim().split(/\s+/)[0].toLowerCase());
    return fixture.run(...args);
  });
  try {
    const created = await getRawSettingsRow("new-settings-owner");
    assert.equal(created.id, "new-settings-owner");
    assert.equal(created.dailyFlashLimit, 73);
    assert.equal(created.embeddingDims, 768);
    assert.equal(created.textProvider, "gemini");
    assert.deepEqual(created.keys, []);
    assert.ok(created.updatedAt instanceof Date);
    const stored = (await fixture.pg.query<{ daily_flash_limit: number; updated_at: string }>(
      `SELECT daily_flash_limit,to_char(updated_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') updated_at FROM ai_settings WHERE id=$1`, [created.id],
    )).rows[0];
    assert.equal(created.dailyFlashLimit, stored.daily_flash_limit);
    assert.equal(created.updatedAt.toISOString(), stored.updated_at);
    assert.deepEqual(operations, ["select", "insert"]);
  } finally { query.mock.restore(); await fixture.close(); }
});

test("existing settings stay a single read and retain owner-bound raw credentials", async () => {
  const fixture = await accountsDb();
  const { pool } = await import("../src/db");
  const { getRawSettingsRow } = await import("../src/lib/ai-settings");
  const credential = "enc:v1:unavailable:raw-storage-fixture";
  await fixture.pg.query("INSERT INTO ai_settings(id,daily_flash_limit,openrouter_key) VALUES ($1,41,$2),($3,99,'other-owner-key')", ["existing-settings-owner", credential, "other-settings-owner"]);
  const operations: string[] = [];
  const query = mock.method(pool, "query", async (...args: Parameters<typeof fixture.run>) => {
    const sql = typeof args[0] === "string" ? args[0] : args[0].text;
    operations.push(sql.trim().split(/\s+/)[0].toLowerCase());
    return fixture.run(...args);
  });
  try {
    const row = await getRawSettingsRow("existing-settings-owner");
    assert.equal(row.id, "existing-settings-owner");
    assert.equal(row.dailyFlashLimit, 41);
    assert.equal(row.openrouterKey, credential);
    assert.deepEqual(operations, ["select"]);
  } finally { query.mock.restore(); await fixture.close(); }
});

test("a competing creator after the initial miss wins without being overwritten", async () => {
  const fixture = await accountsDb();
  const { pool } = await import("../src/db");
  const { getRawSettingsRow } = await import("../src/lib/ai-settings");
  const owner = "competing-settings-owner", credential = "enc:v1:unavailable:competing-owner-fixture";
  const operations: string[] = [];
  let competingInsert = false;
  const query = mock.method(pool, "query", async (...args: Parameters<typeof fixture.run>) => {
    const sql = typeof args[0] === "string" ? args[0] : args[0].text;
    const operation = sql.trim().split(/\s+/)[0].toLowerCase();
    operations.push(operation);
    // Deterministic SQL interleaving: a different creator commits after our miss.
    if (operation === "insert" && !competingInsert) {
      competingInsert = true;
      await fixture.pg.query("INSERT INTO ai_settings(id,daily_flash_limit,text_provider,text_model,openrouter_key,updated_at) VALUES ($1,77,'openrouter','winner/model',$2,'2020-01-02T03:04:05Z')", [owner, credential]);
    }
    return fixture.run(...args);
  });
  try {
    const row = await getRawSettingsRow(owner);
    assert.equal(competingInsert, true);
    assert.equal(row.id, owner);
    assert.equal(row.dailyFlashLimit, 77);
    assert.equal(row.textProvider, "openrouter");
    assert.equal(row.textModel, "winner/model");
    assert.equal(row.openrouterKey, credential);
    assert.equal(row.updatedAt.toISOString(), "2020-01-02T03:04:05.000Z");
    assert.deepEqual(operations, ["select", "insert", "select"]);
    const stored = (await fixture.pg.query<{ daily_flash_limit: number; openrouter_key: string }>("SELECT daily_flash_limit,openrouter_key FROM ai_settings WHERE id=$1", [owner])).rows[0];
    assert.deepEqual(stored, { daily_flash_limit: 77, openrouter_key: credential });
  } finally { query.mock.restore(); await fixture.close(); }
});

test("a conflict winner removed before the fallback read fails instead of inventing settings", async () => {
  const fixture = await accountsDb();
  const { pool } = await import("../src/db");
  const { getRawSettingsRow } = await import("../src/lib/ai-settings");
  const owner = "removed-settings-owner";
  const query = mock.method(pool, "query", async (...args: Parameters<typeof fixture.run>) => {
    const sql = typeof args[0] === "string" ? args[0] : args[0].text;
    if (!/^insert /i.test(sql)) return fixture.run(...args);
    await fixture.pg.query("INSERT INTO ai_settings(id) VALUES ($1)", [owner]);
    const result = await fixture.run(...args);
    await fixture.pg.query("DELETE FROM ai_settings WHERE id=$1", [owner]);
    return result;
  });
  try {
    await assert.rejects(() => getRawSettingsRow(owner), /Settings row was not created/);
  } finally { query.mock.restore(); await fixture.close(); }
});
