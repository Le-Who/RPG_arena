import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountsDb } from "./helpers/accounts-db";
import {
  hasStoredSettingsCredentials,
  openSecret,
  rebindSettingsSecrets,
  sealSecret,
  secretContext,
  type SecretKeyring,
} from "../src/lib/secret-vault";

const ring: SecretKeyring = {
  active: "import-v1",
  keys: { "import-v1": Buffer.alloc(32, 13).toString("base64") },
};

test("external narrator credentials count as owned secrets and are rebound on profile import", () => {
  assert.equal(hasStoredSettingsCredentials({ openrouterKey: "stored" }), true);
  assert.equal(hasStoredSettingsCredentials({ pollinationsKey: "stored" }), true);
  const source = {
    id: "global", keys: [], typesafeKey: "", narrativeGuardProvider: "openrouter", narrativeGuardKey: "",
    openrouterKey: sealSecret("router", secretContext("global", "text:openrouter"), ring),
    pollinationsKey: sealSecret("pollen", secretContext("global", "text:pollinations"), ring),
  };
  const rebound = rebindSettingsSecrets(source, "owner-a", { keyring: ring });
  assert.equal(openSecret(rebound.openrouterKey!, secretContext("owner-a", "text:openrouter"), { keyring: ring }), "router");
  assert.equal(openSecret(rebound.pollinationsKey!, secretContext("owner-a", "text:pollinations"), { keyring: ring }), "pollen");
});

test("legacy settings credentials are decrypted under the source owner and resealed for the target owner", () => {
  const source = {
    id: "global",
    keys: [sealSecret("legacy-gemini", secretContext("global", "gemini"), ring)],
    typesafeKey: sealSecret("legacy-jev", secretContext("global", "typesafe-pilot"), ring),
    narrativeGuardProvider: "openrouter",
    narrativeGuardKey: sealSecret("legacy-narrative", secretContext("global", "narrative:openrouter"), ring),
  };

  const rebound = rebindSettingsSecrets(source, "owner-a", { keyring: ring });
  assert.equal(openSecret(rebound.keys[0], secretContext("owner-a", "gemini"), { keyring: ring }), "legacy-gemini");
  assert.equal(openSecret(rebound.typesafeKey, secretContext("owner-a", "typesafe-pilot"), { keyring: ring }), "legacy-jev");
  assert.equal(openSecret(rebound.narrativeGuardKey, secretContext("owner-a", "narrative:openrouter"), { keyring: ring }), "legacy-narrative");
  assert.throws(() => openSecret(rebound.keys[0], secretContext("global", "gemini"), { keyring: ring }));
});

test("legacy plaintext import requires explicit permission and malformed data is rejected safely", () => {
  const plaintext = { id: "global", keys: ["legacy-gemini"], typesafeKey: "legacy-jev", narrativeGuardProvider: "typesafe", narrativeGuardKey: "legacy-narrative" };
  assert.throws(() => rebindSettingsSecrets(plaintext, "owner-a", { keyring: ring }), error => {
    assert.equal((error as { code?: string }).code, "SECRET_MIGRATION_REQUIRED");
    return true;
  });
  const rebound = rebindSettingsSecrets(plaintext, "owner-a", { keyring: ring, allowPlaintext: true });
  assert.equal(openSecret(rebound.narrativeGuardKey, secretContext("owner-a", "narrative:typesafe"), { keyring: ring }), "legacy-narrative");
  assert.throws(() => rebindSettingsSecrets({ ...plaintext, keys: { invalid: true } as unknown as string[] }, "owner-a", { keyring: ring, allowPlaintext: true }), error => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes("legacy-gemini"));
    return /malformed/i.test(error.message);
  });
});

async function legacyAssignmentFixture() {
  const fixture = await accountsDb();
  const profile = `guest:${"c".repeat(64)}`;
  const campaign = randomUUID();
  process.env.CHRONICLE_SECRET_ACTIVE_KEY = ring.active;
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify(ring.keys);
  await fixture.pg.query("INSERT INTO workspace_preferences(id,display_name) VALUES ($1,'Target name'),('local','Legacy name')", [profile]);
  await fixture.pg.query("INSERT INTO game_sessions(id,title,character,world_state,visibility) VALUES ($1,'Legacy campaign','{}','{}','public')", [campaign]);
  await fixture.pg.query("INSERT INTO token_logs(session_id,model,task_type) VALUES ($1,'synthetic','narration')", [campaign]);
  const credentials = {
    keys: [sealSecret("fixture-gemini", secretContext("global", "gemini"), ring)],
    typesafe: sealSecret("fixture-pilot", secretContext("global", "typesafe-pilot"), ring),
    narrative: sealSecret("fixture-reviewer", secretContext("global", "narrative:openrouter"), ring),
    openrouter: sealSecret("fixture-router", secretContext("global", "text:openrouter"), ring),
    pollinations: sealSecret("fixture-pollen", secretContext("global", "text:pollinations"), ring),
  };
  await fixture.pg.query("INSERT INTO ai_settings(id,keys,typesafe_key,narrative_guard_key,openrouter_key,pollinations_key,daily_flash_limit) VALUES ('global',$1,$2,$3,$4,$5,7)",
    [JSON.stringify(credentials.keys), credentials.typesafe, credentials.narrative, credentials.openrouter, credentials.pollinations]);
  const snapshot = async () => ({
    campaigns: (await fixture.pg.query("SELECT id,owner_id,visibility FROM game_sessions ORDER BY id")).rows,
    settings: (await fixture.pg.query<{ id: string; [column: string]: unknown }>("SELECT * FROM ai_settings ORDER BY id")).rows,
    workspace: (await fixture.pg.query("SELECT * FROM workspace_preferences ORDER BY id")).rows,
    tokens: (await fixture.pg.query("SELECT id,owner_id FROM token_logs ORDER BY id")).rows,
  });
  return { ...fixture, profile, campaign, snapshot, async close() {
    delete process.env.CHRONICLE_SECRET_ACTIVE_KEY; delete process.env.CHRONICLE_SECRET_KEYS;
    await fixture.close();
  } };
}

test("offline assignment refuses a narrative-only target credential through its real apply transaction", async () => {
  const fixture = await legacyAssignmentFixture();
  try {
    const { applyLegacyProfileAssignment } = await import("../scripts/lib/legacy-profile-target");
    assert.equal(typeof applyLegacyProfileAssignment, "function", "offline utility must expose its actual transactional apply");
    await fixture.pg.query("INSERT INTO ai_settings(id,narrative_guard_key) VALUES ($1,$2)",
      [fixture.profile, sealSecret("already-owned", secretContext(fixture.profile, "narrative:openrouter"), ring)]);
    const before = await fixture.snapshot();
    await assert.rejects(() => applyLegacyProfileAssignment({ profile: fixture.profile, campaignIds: [fixture.campaign], includeSettings: true, allowPlaintext: false }), /Target already has credentials/);
    assert.deepEqual(await fixture.snapshot(), before, "campaign, settings, workspace and token owners are unchanged");
  } finally { await fixture.close(); }
});

test("offline assignment rebinds owner credentials and assigns only legacy campaign telemetry", async () => {
  const fixture = await legacyAssignmentFixture();
  try {
    const { applyLegacyProfileAssignment } = await import("../scripts/lib/legacy-profile-target");
    assert.equal(typeof applyLegacyProfileAssignment, "function", "offline utility must expose its actual transactional apply");
    await fixture.pg.query("INSERT INTO token_logs(session_id,owner_id,model,task_type) VALUES ($1,'existing-owner','synthetic','narration')", [fixture.campaign]);
    const before = await fixture.snapshot();
    await applyLegacyProfileAssignment({ profile: fixture.profile, campaignIds: [fixture.campaign], includeSettings: true, allowPlaintext: false });
    const target = (await fixture.pg.query<{ keys: string[]; typesafe_key: string; narrative_guard_key: string; openrouter_key: string; pollinations_key: string; daily_flash_limit: number }>("SELECT * FROM ai_settings WHERE id=$1", [fixture.profile])).rows[0];
    assert.equal(openSecret(target.keys[0], secretContext(fixture.profile, "gemini"), { keyring: ring }), "fixture-gemini");
    assert.equal(openSecret(target.typesafe_key, secretContext(fixture.profile, "typesafe-pilot"), { keyring: ring }), "fixture-pilot");
    assert.equal(openSecret(target.narrative_guard_key, secretContext(fixture.profile, "narrative:openrouter"), { keyring: ring }), "fixture-reviewer");
    assert.equal(openSecret(target.openrouter_key, secretContext(fixture.profile, "text:openrouter"), { keyring: ring }), "fixture-router");
    assert.equal(openSecret(target.pollinations_key, secretContext(fixture.profile, "text:pollinations"), { keyring: ring }), "fixture-pollen");
    assert.throws(() => openSecret(target.keys[0], secretContext("global", "gemini"), { keyring: ring }));
    assert.equal(target.daily_flash_limit, 7);
    assert.deepEqual((await fixture.pg.query("SELECT owner_id,visibility FROM game_sessions WHERE id=$1", [fixture.campaign])).rows, [{ owner_id: fixture.profile, visibility: "private" }]);
    assert.deepEqual((await fixture.pg.query("SELECT owner_id FROM token_logs ORDER BY owner_id")).rows, [{ owner_id: "existing-owner" }, { owner_id: fixture.profile }]);
    assert.deepEqual((await fixture.pg.query("SELECT display_name FROM workspace_preferences WHERE id=$1", [fixture.profile])).rows, [{ display_name: "Legacy name" }]);
    assert.deepEqual((await fixture.snapshot()).settings.filter(row => row.id === "global"), before.settings);
  } finally { await fixture.close(); }
});

test("offline assignment rolls back imported settings when a previewed campaign already changed owner", async () => {
  const fixture = await legacyAssignmentFixture();
  try {
    const { applyLegacyProfileAssignment } = await import("../scripts/lib/legacy-profile-target");
    assert.equal(typeof applyLegacyProfileAssignment, "function", "offline utility must expose its actual transactional apply");
    const changed = randomUUID();
    await fixture.pg.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,'other-owner','Claimed after preview','{}','{}')", [changed]);
    const before = await fixture.snapshot();
    await assert.rejects(() => applyLegacyProfileAssignment({ profile: fixture.profile, campaignIds: [fixture.campaign, changed], includeSettings: true, allowPlaintext: false }), /Ownership changed concurrently/);
    assert.deepEqual(await fixture.snapshot(), before, "real imported settings and partial campaign assignment roll back together");
  } finally { await fixture.close(); }
});

test("offline assignment rolls back target-row creation when source credentials cannot be decrypted", async () => {
  const fixture = await legacyAssignmentFixture();
  try {
    const { applyLegacyProfileAssignment } = await import("../scripts/lib/legacy-profile-target");
    assert.equal(typeof applyLegacyProfileAssignment, "function", "offline utility must expose its actual transactional apply");
    await fixture.pg.query("UPDATE ai_settings SET narrative_guard_key='enc:v1:missing:AA:AA:AA' WHERE id='global'");
    const before = await fixture.snapshot();
    await assert.rejects(() => applyLegacyProfileAssignment({ profile: fixture.profile, campaignIds: [fixture.campaign], includeSettings: true, allowPlaintext: false }), error => (error as { code?: string }).code === "SECRET_DECRYPTION_FAILED");
    assert.deepEqual(await fixture.snapshot(), before, "failed decryption cannot leave a default target settings row or ownership changes");
  } finally { await fixture.close(); }
});
