import test from "node:test";
import assert from "node:assert/strict";
import { installSyntheticSecretKeyring } from "../scripts/lib/synthetic-secret-keyring";
import { openSecret, sealSecret, secretContext } from "../src/lib/secret-vault";

test("smoke fixtures install an isolated keyring readable under strict mode", () => {
  const beforeActive = process.env.CHRONICLE_SECRET_ACTIVE_KEY;
  const beforeKeys = process.env.CHRONICLE_SECRET_KEYS;
  try {
    const ring = installSyntheticSecretKeyring("fixture-v1");
    const sealed = sealSecret("synthetic-only", secretContext("smoke-owner", "gemini"), ring);
    assert.equal(openSecret(sealed, secretContext("smoke-owner", "gemini")), "synthetic-only");
    assert.throws(() => openSecret("synthetic-only", secretContext("smoke-owner", "gemini")));
  } finally {
    if (beforeActive === undefined) delete process.env.CHRONICLE_SECRET_ACTIVE_KEY;
    else process.env.CHRONICLE_SECRET_ACTIVE_KEY = beforeActive;
    if (beforeKeys === undefined) delete process.env.CHRONICLE_SECRET_KEYS;
    else process.env.CHRONICLE_SECRET_KEYS = beforeKeys;
  }
});
