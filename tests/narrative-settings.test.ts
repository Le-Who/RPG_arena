import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { resolveNarrativeGuardConfig, narrativeSettingsView, parseNarrativeSettingsUpdate, narrativeSettingsPatch } from "../src/lib/narrative-settings";
import { POST } from "../src/app/api/settings/narrative/route";

test("default checking uses personal then administrator credentials and skips when neither exists", () => {
  const admin = { provider: "openrouter" as const, apiKey: "administrator-secret" };
  const automatic = resolveNarrativeGuardConfig({}, admin);
  assert.equal(automatic.enabled, true);
  assert.equal(automatic.credentialSource, "administrator");
  assert.equal(automatic.apiKey, admin.apiKey);
  const personal = resolveNarrativeGuardConfig({ narrativeGuardProvider: "typesafe", narrativeGuardKey: "personal-secret" }, admin);
  assert.equal(personal.provider, "typesafe");
  assert.equal(personal.apiKey, "personal-secret");
  assert.equal(personal.credentialSource, "personal");
  assert.equal(resolveNarrativeGuardConfig({ narrativeGuardEnabled: false }, admin).enabled, false);
  assert.equal(resolveNarrativeGuardConfig({}).enabled, false);
  assert.equal(resolveNarrativeGuardConfig({}).requestedEnabled, true);
  const view = narrativeSettingsView({}, admin);
  assert.equal(view.enabled, true);
  assert.equal(view.active, true);
  assert.equal(view.credentialSource, "administrator");
  assert.equal(view.maskedKey, null);
  assert.ok(!JSON.stringify(view).includes("secret"));
});

test("narrative credentials skip without keys and never borrow shadow or Gemini credentials", () => {
  const row = { typesafeKey: "shadow-secret", keys: ["gemini-secret"], typesafePilotEnabled: true };
  assert.deepEqual(resolveNarrativeGuardConfig(row), { enabled: false, requestedEnabled: true, provider: "openrouter", apiKey: "", credentialSource: "none" });
  const alice = { narrativeGuardEnabled: true, narrativeGuardProvider: "typesafe", narrativeGuardKey: "  alice-secret-key  " };
  assert.deepEqual(resolveNarrativeGuardConfig(alice), { enabled: true, requestedEnabled: true, provider: "typesafe", apiKey: "alice-secret-key", credentialSource: "personal" });
  assert.equal(resolveNarrativeGuardConfig({}).apiKey, "");
  assert.equal(resolveNarrativeGuardConfig({ narrativeGuardEnabled: true }).enabled, false);
  assert.equal(resolveNarrativeGuardConfig({ ...alice, narrativeGuardProvider: "invalid" }).apiKey, "");
});

test("public settings expose readiness and provider model without raw credentials", () => {
  const view = narrativeSettingsView({ narrativeGuardEnabled: true, narrativeGuardProvider: "openrouter", narrativeGuardKey: "owner-private-key" });
  assert.equal(view.configured, true);
  assert.equal(view.model, "typesafe/jev-1.13");
  assert.equal(view.maskedKey, "••••-key");
  assert.ok(!JSON.stringify(view).includes("owner-private"));
  assert.equal(narrativeSettingsView({}).maskedKey, null);
});

test("settings updates reject invalid inputs and clear credentials on provider change", () => {
  for (const input of [{ provider: "gemini" }, { enabled: "true" }, { clearKey: 1 }, { key: "short" }, { key: "x".repeat(501) }, { key: "a".repeat(12), clearKey: true }, { ownerId: "bob" }, { key: "has\nnewline123" }]) {
    assert.throws(() => parseNarrativeSettingsUpdate(input));
  }
  const row = { narrativeGuardEnabled: true, narrativeGuardProvider: "openrouter", narrativeGuardKey: "owner-private-key" };
  assert.deepEqual(narrativeSettingsPatch(row, { provider: "typesafe" }), { narrativeGuardProvider: "typesafe", narrativeGuardKey: "" });
  assert.deepEqual(narrativeSettingsPatch(row, { enabled: false }), { narrativeGuardEnabled: false });
  assert.deepEqual(narrativeSettingsPatch(row, { clearKey: true }), { narrativeGuardKey: "" });
  assert.deepEqual(narrativeSettingsPatch(row, { provider: "typesafe", key: "new-provider-key" }), { narrativeGuardProvider: "typesafe", narrativeGuardKey: "new-provider-key" });
});

test("additive migration preserves existing credentials and enables verification preference by default", async () => {
  const pg = new PGlite();
  try {
    await pg.exec("CREATE TABLE ai_settings(id text primary key, typesafe_key text, typesafe_pilot_enabled boolean); INSERT INTO ai_settings VALUES ('alice','shadow',true),('bob','',false)");
    await pg.exec(await readFile(new URL("../drizzle/0007_narrative_verification.sql", import.meta.url), "utf8"));
    const rows = (await pg.query("SELECT * FROM ai_settings ORDER BY id")).rows as Record<string, unknown>[];
    assert.equal(rows[0].typesafe_key, "shadow");
    for (const row of rows) {
      assert.equal(row.narrative_guard_enabled, true);
      assert.equal(row.narrative_guard_provider, "openrouter");
      assert.equal(row.narrative_guard_key, "");
    }
  } finally { await pg.close(); }
});

test("settings endpoint rejects malformed or oversized bodies before any storage access", async () => {
  for (const [body, status] of [["[]", 400], ["{broken", 400], [JSON.stringify({ key: "x".repeat(4200) }), 413]] as const) {
    const response = await POST(new Request("http://localhost/api/settings/narrative", { method: "POST", headers: { "content-type": "application/json" }, body }));
    assert.equal(response.status, status);
    assert.ok(!JSON.stringify(await response.json()).includes("xxxx"));
  }
  const response = await POST(new Request("http://localhost/api/settings/narrative", { method: "POST", body: "secret" }));
  assert.equal(response.status, 415);
});
