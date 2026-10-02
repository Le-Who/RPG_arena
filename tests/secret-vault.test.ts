import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  decodeSettingsSecrets,
  isSealedSecret,
  openSecret,
  sealSecret,
  secretContext,
  secretNeedsRotation,
  type SecretKeyring,
} from "../src/lib/secret-vault";

const ring: SecretKeyring = {
  active: "test-v1",
  keys: {
    "test-v1": Buffer.alloc(32, 7).toString("base64"),
    "test-v0": Buffer.alloc(32, 3).toString("base64"),
  },
};
const geminiContext = secretContext("owner-a", "gemini");

test("authenticated envelopes use a fresh IV and are bound to owner and purpose", () => {
  const first = sealSecret("test-api-key", geminiContext, ring);
  const second = sealSecret("test-api-key", geminiContext, ring);

  assert.notEqual(first, second);
  assert.ok(isSealedSecret(first));
  assert.ok(!first.includes("test-api-key"));
  assert.equal(openSecret(first, geminiContext, { keyring: ring }), "test-api-key");
  assert.throws(() => openSecret(first, secretContext("owner-b", "gemini"), { keyring: ring }));
  assert.throws(() => openSecret(first, secretContext("owner-a", "typesafe-pilot"), { keyring: ring }));
});

test("tampering, malformed envelopes, and unknown envelope versions are rejected", () => {
  const sealed = sealSecret("test-api-key", geminiContext, ring);
  const tampered = sealed.split(":");
  tampered[4] = `${tampered[4][0] === "A" ? "B" : "A"}${tampered[4].slice(1)}`;

  assert.throws(() => openSecret(tampered.join(":"), geminiContext, { keyring: ring }));
  assert.throws(() => openSecret(sealed.split(":").slice(0, 5).join(":"), geminiContext, { keyring: ring }));
  assert.throws(() => openSecret(sealed.replace("enc:v1:", "enc:v2:"), geminiContext, { keyring: ring, allowPlaintext: true }));
});

test("keyrings require a valid active id and exact 32-byte base64 key material", () => {
  const invalid: SecretKeyring[] = [
    { active: "", keys: { "": ring.keys["test-v1"] } },
    { active: "missing", keys: { "test-v1": ring.keys["test-v1"] } },
    { active: "test-v1", keys: { "test-v1": "not-base64" } },
    { active: "test-v1", keys: { "test-v1": randomBytes(31).toString("base64") } },
    { active: "test-v1", keys: { "test-v1": ring.keys["test-v1"], old: "not-base64" } },
  ];
  for (const keyring of invalid) {
    assert.throws(() => sealSecret("never-log-this", geminiContext, keyring));
  }
});

test("legacy plaintext is readable only with an explicit opt-in and empty values need no keyring", () => {
  assert.throws(() => openSecret("old-plain", geminiContext, { keyring: ring }));
  assert.equal(openSecret("old-plain", geminiContext, { keyring: ring, allowPlaintext: true }), "old-plain");
  assert.equal(sealSecret("", geminiContext), "");
  assert.equal(openSecret("", geminiContext), "");
});

test("old key material remains readable and can be resealed with the active key", () => {
  const oldRing = { ...ring, active: "test-v0" };
  const old = sealSecret("rotating-key", geminiContext, oldRing);
  assert.equal(openSecret(old, geminiContext, { keyring: ring }), "rotating-key");
  assert.equal(secretNeedsRotation(old, ring.active), true);

  const resealed = sealSecret(openSecret(old, geminiContext, { keyring: ring }), geminiContext, ring);
  assert.equal(secretNeedsRotation(resealed, ring.active), false);
  assert.equal(openSecret(resealed, geminiContext, { keyring: ring }), "rotating-key");
  assert.throws(() => openSecret(old, geminiContext, { keyring: { active: "test-v1", keys: { "test-v1": ring.keys["test-v1"] } } }));
});

test("settings decoder uses distinct owner and provider contexts", () => {
  const raw = {
    id: "owner-a",
    keys: [sealSecret("gemini-one", secretContext("owner-a", "gemini"), ring)],
    typesafeKey: sealSecret("jev-one", secretContext("owner-a", "typesafe-pilot"), ring),
    narrativeGuardProvider: "typesafe",
    narrativeGuardKey: sealSecret("narrative-one", secretContext("owner-a", "narrative:typesafe"), ring),
    untouched: 17,
  };

  assert.deepEqual(decodeSettingsSecrets(raw, { keyring: ring }), {
    ...raw,
    keys: ["gemini-one"],
    typesafeKey: "jev-one",
    narrativeGuardKey: "narrative-one",
  });
  assert.throws(() => decodeSettingsSecrets({ ...raw, id: "owner-b" }, { keyring: ring }));
  assert.throws(() => decodeSettingsSecrets({ ...raw, narrativeGuardProvider: "openrouter" }, { keyring: ring }));
});
