import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertMaskedSecretResponse, installSyntheticSecretKeyring, requireSharedIsolatedSecretKeyring } from "../scripts/lib/synthetic-secret-keyring";
import { openSecret, sealSecret, secretContext } from "../src/lib/secret-vault";

const exec = promisify(execFile);

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

test("shared smoke keyring decrypts across processes while an independent ring cannot", async () => {
  const before = { active: process.env.CHRONICLE_SECRET_ACTIVE_KEY, keys: process.env.CHRONICLE_SECRET_KEYS, isolated: process.env.ARENA_ISOLATED_TEST_DB };
  try {
    delete process.env.CHRONICLE_SECRET_ACTIVE_KEY;
    delete process.env.CHRONICLE_SECRET_KEYS;
    process.env.ARENA_ISOLATED_TEST_DB = "1";
    assert.throws(() => requireSharedIsolatedSecretKeyring(), /shared.*keyring/i);

    const shared = installSyntheticSecretKeyring("shared-v1");
    const context = secretContext("smoke-owner", "typesafe-pilot");
    const sealed = sealSecret("synthetic-cross-process", context, shared);
    const childCode = `import { openSecret } from './src/lib/secret-vault.ts'; openSecret(process.env.FIXTURE, process.env.CONTEXT);`;
    const baseEnv = { ...process.env, FIXTURE: sealed, CONTEXT: context, ARENA_ISOLATED_TEST_DB: "1" };
    const independent = { active: "other-v1", keys: { "other-v1": Buffer.alloc(32, 31).toString("base64") } };
    await assert.rejects(exec(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childCode], {
      cwd: process.cwd(), env: { ...baseEnv, CHRONICLE_SECRET_ACTIVE_KEY: independent.active, CHRONICLE_SECRET_KEYS: JSON.stringify(independent.keys) },
    }));
    await exec(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childCode], {
      cwd: process.cwd(), env: { ...baseEnv, CHRONICLE_SECRET_ACTIVE_KEY: shared.active, CHRONICLE_SECRET_KEYS: JSON.stringify(shared.keys) },
    });
    assert.deepEqual(requireSharedIsolatedSecretKeyring(), shared);
  } finally {
    if (before.active === undefined) delete process.env.CHRONICLE_SECRET_ACTIVE_KEY; else process.env.CHRONICLE_SECRET_ACTIVE_KEY = before.active;
    if (before.keys === undefined) delete process.env.CHRONICLE_SECRET_KEYS; else process.env.CHRONICLE_SECRET_KEYS = before.keys;
    if (before.isolated === undefined) delete process.env.ARENA_ISOLATED_TEST_DB; else process.env.ARENA_ISOLATED_TEST_DB = before.isolated;
  }
});

test("masking checks reject HTTP errors before inspecting response JSON", async () => {
  await assert.rejects(assertMaskedSecretResponse(new Response(JSON.stringify({ ok: false }), { status: 503 }), "synthetic-cross-process"), /HTTP 200/i);
  const body = await assertMaskedSecretResponse(Response.json({ configured: true, maskedKey: "••••cess" }), "synthetic-cross-process");
  assert.deepEqual(body, { configured: true, maskedKey: "••••cess" });
});
