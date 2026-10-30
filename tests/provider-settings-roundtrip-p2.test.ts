import test from "node:test";
import assert from "node:assert/strict";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { newGuestToken, profileIdFromToken } from "../src/lib/guest-identity";
import { openSecret, secretContext } from "../src/lib/secret-vault";

// Removing the handler's identity boundary, key retention, secret sealing, or selected-provider
// configuration would fail these actual POST -> GET round trips. No provider is contacted.
async function fixture() {
  const database = await accountsDb();
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ p2: Buffer.alloc(32, 71).toString("base64") });
  process.env.CHRONICLE_SECRET_ACTIVE_KEY = "p2";
  const { GET, POST } = await import("../src/app/api/settings/text-provider/route");
  const guest = newGuestToken();
  const cookie = `chronicle_guest=${guest}`;
  return {
    ...database, cookie, owner: profileIdFromToken(guest)!,
    get: (identity = cookie) => cookieContext(identity, () => GET()),
    post: (body: unknown, identity = cookie) => cookieContext(identity, () => POST(new Request("http://localhost/api/settings/text-provider", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }))),
    async dispose() {
      delete process.env.CHRONICLE_SECRET_KEYS;
      delete process.env.CHRONICLE_SECRET_ACTIVE_KEY;
      await database.close();
    },
  };
}

test("actual provider handlers round trip OpenRouter and Pollinations with sealed owner credentials and selected AI config", async () => {
  const f = await fixture();
  try {
    const { getAIConfig, pickModels } = await import("../src/lib/ai-settings");
    for (const sample of [
      { provider: "openrouter", model: "vendor/story:free", apiKey: "synthetic-router-p2", column: "openrouter_key", want: { provider: "openrouter", model: "vendor/story:free", openrouterConfigured: true, pollinationsConfigured: false, useLiveAI: true } },
      { provider: "pollinations", model: "openai", apiKey: "synthetic-pollen-p2", column: "pollinations_key", want: { provider: "pollinations", model: "openai", openrouterConfigured: true, pollinationsConfigured: true, useLiveAI: true } },
    ]) {
      const posted = await f.post({ provider: sample.provider, model: sample.model, apiKey: sample.apiKey, useLiveAI: true });
      assert.equal(posted.status, 200);
      assert.equal(posted.headers.get("Cache-Control"), "no-store");
      assert.deepEqual(await posted.json(), { ok: true, ...sample.want });
      const loaded = await f.get();
      assert.equal(loaded.status, 200);
      assert.equal(loaded.headers.get("Cache-Control"), "no-store");
      assert.deepEqual(await loaded.json(), sample.want);
      const row = (await f.pg.query<{ openrouter_key: string; pollinations_key: string }>("SELECT openrouter_key,pollinations_key FROM ai_settings WHERE id=$1", [f.owner])).rows[0];
      const sealed = row[sample.column as keyof typeof row];
      assert.match(sealed, /^enc:v1:/);
      assert.equal(openSecret(sealed, secretContext(f.owner, `text:${sample.provider}`)), sample.apiKey);
      assert.throws(() => openSecret(sealed, secretContext("another-owner", `text:${sample.provider}`)));
      const cfg = await getAIConfig(f.owner);
      assert.equal(cfg.textProvider, sample.provider);
      assert.equal(cfg.textModel, sample.model);
      assert.equal(cfg.textApiKey, sample.apiKey);
      assert.equal(cfg.canUseLive, true);
      assert.deepEqual(await pickModels("narration", { ...cfg, enforceLimits: false }), { models: [sample.model], skipped: [] });
    }
  } finally { await f.dispose(); }
});

test("actual provider POST retains omitted keys, clears only the selected credential, and retains live intent without readiness", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post({ provider: "openrouter", model: "vendor/first", apiKey: "synthetic-retained-router", useLiveAI: true })).status, 200);
    assert.equal((await f.post({ provider: "pollinations", model: "openai", apiKey: "synthetic-cleared-pollen", useLiveAI: true })).status, 200);
    const before = (await f.pg.query<{ openrouter_key: string; pollinations_key: string }>("SELECT openrouter_key,pollinations_key FROM ai_settings WHERE id=$1", [f.owner])).rows[0];
    assert.equal((await f.post({ provider: "openrouter", model: "vendor/second", useLiveAI: true })).status, 200);
    assert.deepEqual(await (await f.get()).json(), { provider: "openrouter", model: "vendor/second", openrouterConfigured: true, pollinationsConfigured: true, useLiveAI: true });
    const after = (await f.pg.query<{ openrouter_key: string; pollinations_key: string }>("SELECT openrouter_key,pollinations_key FROM ai_settings WHERE id=$1", [f.owner])).rows[0];
    assert.deepEqual(after, before, "omitting apiKey must preserve both sealed values byte-for-byte");
    assert.equal((await f.post({ provider: "pollinations", model: "openai", clearKey: true, useLiveAI: true })).status, 200);
    assert.deepEqual(await (await f.get()).json(), { provider: "pollinations", model: "openai", openrouterConfigured: true, pollinationsConfigured: false, useLiveAI: true });
    const cleared = (await f.pg.query<{ openrouter_key: string; pollinations_key: string }>("SELECT openrouter_key,pollinations_key FROM ai_settings WHERE id=$1", [f.owner])).rows[0];
    assert.equal(cleared.openrouter_key, before.openrouter_key);
    assert.equal(cleared.pollinations_key, "");
    const { getAIConfig } = await import("../src/lib/ai-settings");
    assert.equal((await getAIConfig(f.owner)).canUseLive, false);
    assert.equal((await f.post({ provider: "openrouter", model: "vendor/second", useLiveAI: true })).status, 200);
    assert.equal((await getAIConfig(f.owner)).textApiKey, "synthetic-retained-router");
    assert.equal((await getAIConfig(f.owner)).canUseLive, true);
  } finally { await f.dispose(); }
});

test("actual provider handlers isolate guest and account owners through request cookies", async () => {
  const f = await fixture();
  try {
    const { auth } = await import("../src/lib/auth");
    const { SESSION_COOKIE } = await import("../src/lib/auth-policy");
    const account = await auth.register(newGuestToken(), "provider_p2", "synthetic account password p2");
    const accountCookie = `${SESSION_COOKIE}=${account.sessionToken}`;
    assert.equal((await f.post({ provider: "openrouter", model: "vendor/guest", apiKey: "synthetic-guest-key", useLiveAI: true })).status, 200);
    assert.deepEqual(await (await f.get(accountCookie)).json(), { provider: "gemini", model: "", openrouterConfigured: false, pollinationsConfigured: false, useLiveAI: false });
    assert.equal((await f.post({ provider: "pollinations", model: "openai", apiKey: "synthetic-account-key", useLiveAI: true }, accountCookie)).status, 200);
    assert.deepEqual(await (await f.get()).json(), { provider: "openrouter", model: "vendor/guest", openrouterConfigured: true, pollinationsConfigured: false, useLiveAI: true });
    assert.deepEqual(await (await f.get(accountCookie)).json(), { provider: "pollinations", model: "openai", openrouterConfigured: false, pollinationsConfigured: true, useLiveAI: true });
    const rows = (await f.pg.query<{ id: string; openrouter_key: string; pollinations_key: string }>("SELECT id,openrouter_key,pollinations_key FROM ai_settings ORDER BY id")).rows;
    assert.equal(rows.length, 2);
    const accountRow = rows.find(row => row.id === account.identity.profileId)!;
    assert.equal(openSecret(accountRow.pollinations_key, secretContext(account.identity.profileId, "text:pollinations")), "synthetic-account-key");
    assert.equal(accountRow.openrouter_key, "");
    assert.equal((await f.post({ provider: "gemini", model: "", ownerId: f.owner }, accountCookie)).status, 400);
    assert.equal((await (await f.get()).json()).provider, "openrouter");
  } finally { await f.dispose(); }
});

test("rejected provider POSTs leave the complete persisted draft and secrets unchanged", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post({ provider: "openrouter", model: "vendor/original", apiKey: "synthetic-original-key", useLiveAI: true })).status, 200);
    const before = (await f.pg.query("SELECT * FROM ai_settings WHERE id=$1", [f.owner])).rows[0];
    for (const rejected of [
      { provider: "pollinations", model: "" },
      { provider: "openrouter", model: "vendor/rejected", apiKey: "synthetic-replacement", clearKey: true },
      { provider: "gemini", model: "", apiKey: "synthetic-incompatible" },
      { provider: "openrouter", model: "vendor/rejected", useLiveAI: "true" },
      { provider: "pollinations", model: "openai", ownerId: "another-owner" },
    ]) {
      const response = await f.post(rejected);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "INVALID_INPUT");
      assert.deepEqual((await f.pg.query("SELECT * FROM ai_settings WHERE id=$1", [f.owner])).rows[0], before);
      assert.deepEqual(await (await f.get()).json(), { provider: "openrouter", model: "vendor/original", openrouterConfigured: true, pollinationsConfigured: false, useLiveAI: true });
    }
  } finally { await f.dispose(); }
});

test("selected providers without their own credential cannot make calls or borrow another provider key", async () => {
  const f = await fixture();
  try {
    const { getAIConfig } = await import("../src/lib/ai-settings");
    assert.equal((await f.post({ provider: "openrouter", model: "vendor/ready", apiKey: "synthetic-router-only", useLiveAI: true })).status, 200);
    assert.equal((await f.post({ provider: "pollinations", model: "openai", useLiveAI: true })).status, 200);
    assert.deepEqual(await (await f.get()).json(), { provider: "pollinations", model: "openai", openrouterConfigured: true, pollinationsConfigured: false, useLiveAI: true });
    let cfg = await getAIConfig(f.owner);
    assert.equal(cfg.canUseLive, false);
    assert.equal(cfg.textApiKey, "");
    assert.equal((await f.post({ provider: "gemini", model: "", useLiveAI: true })).status, 200);
    assert.deepEqual(await (await f.get()).json(), { provider: "gemini", model: "", openrouterConfigured: true, pollinationsConfigured: false, useLiveAI: true });
    cfg = await getAIConfig(f.owner);
    assert.equal(cfg.canUseLive, false);
    assert.deepEqual(cfg.keys, []);
    assert.equal(cfg.textApiKey, "");
  } finally { await f.dispose(); }
});
