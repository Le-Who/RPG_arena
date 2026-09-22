import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
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

test("narrative credentials count as target credentials and abort an isolated transaction", async () => {
  assert.equal(hasStoredSettingsCredentials({ keys: [], typesafeKey: "", narrativeGuardKey: "already-owned" }), true);
  const pg = new PGlite();
  try {
    await pg.exec("CREATE TABLE campaigns(id text primary key, owner_id text); CREATE TABLE settings(id text primary key, narrative_key text); INSERT INTO campaigns VALUES ('campaign-a',NULL); INSERT INTO settings VALUES ('owner-a','already-owned')");
    await assert.rejects(pg.transaction(async tx => {
      await tx.query("UPDATE campaigns SET owner_id='owner-a' WHERE id='campaign-a'");
      const target = (await tx.query("SELECT narrative_key FROM settings WHERE id='owner-a'")).rows[0] as { narrative_key: string };
      if (hasStoredSettingsCredentials({ keys: [], typesafeKey: "", narrativeGuardKey: target.narrative_key })) throw new Error("Target already has credentials");
    }), /already has credentials/);
    assert.equal(((await pg.query("SELECT owner_id FROM campaigns WHERE id='campaign-a'")).rows[0] as { owner_id: string | null }).owner_id, null);
  } finally {
    await pg.close();
  }
});
