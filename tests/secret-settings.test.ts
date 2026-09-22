import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { decodeSettingsSecrets, isSealedSecret, openSecret, secretContext, type SecretKeyring } from "../src/lib/secret-vault";
import { prepareGeminiKeysWrite } from "../src/lib/ai-settings";
import { narrativeSettingsPatch, prepareNarrativeSettingsWrite, narrativeSettingsView } from "../src/lib/narrative-settings";
import { prepareTypeSafeSettingsWrite, maskTypeSafeKey } from "../src/lib/typesafe-settings";
import { rotateSecrets, type SecretRotationMode } from "../src/lib/secret-rotation";

const ring: SecretKeyring = {
  active: "new-key",
  keys: {
    "new-key": Buffer.alloc(32, 9).toString("base64"),
    "old-key": Buffer.alloc(32, 4).toString("base64"),
  },
};

test("settings writers seal Gemini, Jev, and narrative credentials for raw storage", () => {
  const ownerId = "owner-a";
  const raw = {
    id: ownerId,
    keys: prepareGeminiKeysWrite(ownerId, ["gemini-one", "gemini-two"], ring),
    typesafeKey: prepareTypeSafeSettingsWrite(ownerId, { key: "jev-personal-key" }, ring).typesafeKey!,
    narrativeGuardProvider: "typesafe",
    narrativeGuardKey: prepareNarrativeSettingsWrite(
      ownerId,
      { narrativeGuardProvider: "typesafe", narrativeGuardKey: "" },
      { key: "narrative-personal-key" },
      ring,
    ).narrativeGuardKey!,
  };

  assert.ok(raw.keys.every(isSealedSecret));
  assert.ok(isSealedSecret(raw.typesafeKey));
  assert.ok(isSealedSecret(raw.narrativeGuardKey));
  assert.deepEqual(decodeSettingsSecrets(raw, { keyring: ring }), {
    ...raw,
    keys: ["gemini-one", "gemini-two"],
    typesafeKey: "jev-personal-key",
    narrativeGuardKey: "narrative-personal-key",
  });
});

test("narrative provider-only changes do not decrypt under the new provider AAD", () => {
  const ownerId = "owner-a";
  const rawKey = prepareNarrativeSettingsWrite(
    ownerId,
    { narrativeGuardProvider: "openrouter", narrativeGuardKey: "" },
    { key: "narrative-personal-key" },
    ring,
  ).narrativeGuardKey!;

  const patch = prepareNarrativeSettingsWrite(
    ownerId,
    { narrativeGuardProvider: "openrouter", narrativeGuardKey: rawKey },
    { provider: "typesafe" },
    ring,
  );
  assert.deepEqual(patch, { narrativeGuardProvider: "typesafe", narrativeGuardKey: "" });
  assert.deepEqual(narrativeSettingsPatch(
    { narrativeGuardProvider: "openrouter", narrativeGuardKey: "narrative-personal-key" },
    { provider: "typesafe" },
  ), { narrativeGuardProvider: "typesafe", narrativeGuardKey: "" });
});

test("clear-key writes are empty while settings views remain masked", () => {
  assert.deepEqual(prepareTypeSafeSettingsWrite("owner-a", { clearKey: true }, ring), { typesafeKey: "" });
  assert.deepEqual(prepareNarrativeSettingsWrite(
    "owner-a",
    { narrativeGuardProvider: "openrouter", narrativeGuardKey: "broken-unreadable" },
    { clearKey: true },
    ring,
  ), { narrativeGuardKey: "" });
  assert.equal(maskTypeSafeKey("jev-personal-key"), "••••-key");
  const view = narrativeSettingsView({ narrativeGuardProvider: "openrouter", narrativeGuardKey: "narrative-personal-key" });
  assert.equal(view.maskedKey, "••••-key");
  assert.ok(!JSON.stringify(view).includes("narrative-personal"));
});

test("partial writers do not read or overwrite unrelated broken credentials", () => {
  const gemini = prepareGeminiKeysWrite("owner-a", ["gemini-one"], ring);
  assert.equal(openSecret(gemini[0], secretContext("owner-a", "gemini"), { keyring: ring }), "gemini-one");
  assert.deepEqual(prepareTypeSafeSettingsWrite("owner-a", { pilotEnabled: true }, ring), { typesafePilotEnabled: true });
  assert.deepEqual(prepareNarrativeSettingsWrite(
    "owner-a",
    { narrativeGuardProvider: "openrouter", narrativeGuardKey: "enc:v1:missing:bad:bad:bad" },
    { enabled: false },
    ring,
  ), { narrativeGuardEnabled: false });
});

async function fixture() {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE ai_settings(
      id text PRIMARY KEY,
      keys jsonb DEFAULT '[]'::jsonb,
      typesafe_key text NOT NULL DEFAULT '',
      narrative_guard_provider text NOT NULL DEFAULT 'openrouter',
      narrative_guard_key text NOT NULL DEFAULT '',
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  return pg;
}

async function runRotation(pg: PGlite, mode: SecretRotationMode, allowPlaintext = false) {
  return rotateSecrets({
    mode,
    keyring: ring,
    allowPlaintext,
    batchSize: 1,
    query: (text, params) => pg.query(text, params),
  });
}

test("rotation check and dry-run are read-only while apply reseals bounded fixtures", async () => {
  const pg = await fixture();
  try {
    await pg.query("INSERT INTO ai_settings(id, keys, typesafe_key, narrative_guard_provider, narrative_guard_key) VALUES ($1,$2::jsonb,$3,$4,$5)", [
      "owner-a", JSON.stringify(["legacy-gemini"]), "legacy-jev", "openrouter", "legacy-narrative",
    ]);
    for (const mode of ["check", "dry-run"] as const) {
      const report = await runRotation(pg, mode, true);
      assert.equal(report.needsRotation, 3);
      const row = (await pg.query("SELECT keys, typesafe_key FROM ai_settings WHERE id='owner-a'")).rows[0] as { keys: string[]; typesafe_key: string };
      assert.deepEqual(row.keys, ["legacy-gemini"]);
      assert.equal(row.typesafe_key, "legacy-jev");
    }

    const report = await runRotation(pg, "apply", true);
    assert.equal(report.updatedProfiles, 1);
    const row = (await pg.query("SELECT id, keys, typesafe_key, narrative_guard_provider, narrative_guard_key FROM ai_settings WHERE id='owner-a'")).rows[0] as {
      id: string; keys: string[]; typesafe_key: string; narrative_guard_provider: string; narrative_guard_key: string;
    };
    assert.ok(row.keys.every(isSealedSecret));
    assert.ok(isSealedSecret(row.typesafe_key));
    assert.ok(isSealedSecret(row.narrative_guard_key));
    assert.equal(openSecret(row.narrative_guard_key, secretContext(row.id, "narrative:openrouter"), { keyring: ring }), "legacy-narrative");
  } finally {
    await pg.close();
  }
});

test("rotation refuses unreadable data without overwriting its row", async () => {
  const pg = await fixture();
  try {
    const broken = "enc:v1:missing:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AA";
    await pg.query("INSERT INTO ai_settings(id, keys, typesafe_key) VALUES ($1,$2::jsonb,$3)", ["owner-a", "[]", broken]);
    await assert.rejects(() => runRotation(pg, "apply", true));
    const row = (await pg.query("SELECT typesafe_key FROM ai_settings WHERE id='owner-a'")).rows[0] as { typesafe_key: string };
    assert.equal(row.typesafe_key, broken);
  } finally {
    await pg.close();
  }
});
