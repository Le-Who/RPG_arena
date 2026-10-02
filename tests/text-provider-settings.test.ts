import test from "node:test";
import assert from "node:assert/strict";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { newGuestToken, profileIdFromToken } from "../src/lib/guest-identity";
import { aiSettings } from "../src/db/schema";
import { openSecret, secretContext } from "../src/lib/secret-vault";

test("text provider settings persist owner-scoped sealed credentials without exposing them", async () => {
  assert.ok("textProvider" in aiSettings, "provider storage must exist");
  const { saveTextProviderSettings, getTextProviderSettings, attachPollinationsKey } = await import("../src/lib/text-provider-settings");
  const { getAIConfig, pickModels, logToken } = await import("../src/lib/ai-settings");
  const fixture = await accountsDb();
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ test: Buffer.alloc(32, 42).toString("base64") });
  process.env.CHRONICLE_SECRET_ACTIVE_KEY = "test";
  try {
    const initial = await getTextProviderSettings("provider-owner");
    assert.deepEqual(initial, { provider: "gemini", model: "", openrouterConfigured: false, pollinationsConfigured: false, useLiveAI: false });
    const saved = await saveTextProviderSettings("provider-owner", { provider: "openrouter", model: "vendor/model:free", apiKey: "test-openrouter-secret", useLiveAI: true });
    assert.deepEqual(saved, { provider: "openrouter", model: "vendor/model:free", openrouterConfigured: true, pollinationsConfigured: false, useLiveAI: true });
    assert.ok(!JSON.stringify(saved).includes("test-openrouter-secret"));
    const raw = (await fixture.pg.query<{ openrouter_key: string; keys: string[] }>("SELECT openrouter_key,keys FROM ai_settings WHERE id=$1", ["provider-owner"])).rows[0];
    assert.ok(raw.openrouter_key.startsWith("enc:v1:"));
    assert.deepEqual(raw.keys, []);
    assert.equal(openSecret(raw.openrouter_key, secretContext("provider-owner", "text:openrouter")), "test-openrouter-secret");
    assert.throws(() => openSecret(raw.openrouter_key, secretContext("other-owner", "text:openrouter")));
    assert.throws(() => openSecret(raw.openrouter_key, secretContext("provider-owner", "text:pollinations")));
    const config = await getAIConfig("provider-owner");
    assert.equal(config.canUseLive, true);
    assert.equal(config.textApiKey, "test-openrouter-secret");
    assert.deepEqual(config.keys, []);
    assert.deepEqual(await pickModels("narration", { ...config, enforceLimits: false }), { models: ["vendor/model:free"], skipped: [] });
    await saveTextProviderSettings("provider-owner", { provider: "pollinations", model: "openai", apiKey: "test-pollinations-secret" });
    assert.equal((await getAIConfig("provider-owner")).textApiKey, "test-pollinations-secret");
    const cleared = await saveTextProviderSettings("provider-owner", { provider: "pollinations", model: "openai", clearKey: true });
    assert.equal(cleared.pollinationsConfigured, false);
    assert.equal(cleared.openrouterConfigured, true);
    assert.equal(cleared.useLiveAI, false);
    assert.equal((await getTextProviderSettings("unrelated-owner")).openrouterConfigured, false);
    await saveTextProviderSettings("provider-owner", { provider: "openrouter", model: "vendor/model:free", useLiveAI: true });
    const expiration = new Date(Date.now() + 3600000);
    await attachPollinationsKey("provider-owner", "oauth-pollen-secret", expiration);
    assert.deepEqual(await getTextProviderSettings("provider-owner"), { provider: "openrouter", model: "vendor/model:free", useLiveAI: true, openrouterConfigured: true, pollinationsConfigured: true, pollinationsKeyExpiresAt: expiration.toISOString() });
    await saveTextProviderSettings("provider-owner", { provider: "pollinations", model: "openai", useLiveAI: true });
    await fixture.pg.query("UPDATE ai_settings SET pollinations_key_expires_at=now()-interval '1 minute' WHERE id='provider-owner'");
    assert.equal((await getAIConfig("provider-owner")).canUseLive, false);
    await saveTextProviderSettings("provider-owner", { provider: "pollinations", model: "openai", apiKey: "manual-pollen-secret", useLiveAI: true });
    assert.equal((await getAIConfig("provider-owner")).canUseLive, true);
    assert.equal((await getTextProviderSettings("provider-owner")).pollinationsKeyExpiresAt, undefined);
    const guest = newGuestToken(), guestOwner = profileIdFromToken(guest)!;
    await saveTextProviderSettings(guestOwner, { provider: "openrouter", model: "vendor/lite-model", apiKey: "test-router-secret", useLiveAI: true });
    const { POST: oldSettingsPOST, GET: oldSettingsGET } = await import("../src/app/api/settings/route");
    const oldResponse = await cookieContext(`chronicle_guest=${guest}`, () => oldSettingsPOST(new Request("http://localhost/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dailyFlashLimit: 2 }) })));
    assert.equal(oldResponse.status, 200);
    const oldView = await oldResponse.json();
    assert.equal(oldView.useLiveAI, true);
    assert.equal(oldView.canUseLive, true);
    assert.equal(oldView.textProvider, "openrouter");
    assert.equal(oldView.textModel, "vendor/lite-model");
    assert.equal(oldView.keysCount, 0);
    assert.ok(!JSON.stringify(oldView).includes("test-router-secret"));
    const externalView = await cookieContext(`chronicle_guest=${guest}`, () => oldSettingsGET());
    assert.equal((await externalView.json()).canUseLive, true);
    const { GET, POST } = await import("../src/app/api/settings/text-provider/route");
    const response = await cookieContext(`chronicle_guest=${guest}`, () => GET());
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal((await response.json()).provider, "openrouter");
    assert.equal((await cookieContext(`chronicle_guest=${guest}`, () => POST(new Request("http://localhost/api/settings/text-provider", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "gemini", model: "", ownerId: "provider-owner" }) })))).status, 400);
    await cookieContext(`chronicle_guest=${guest}`, () => logToken({ sessionId: null, provider: "openrouter", model: "vendor/lite-model", taskType: "narration", promptTokens: 1, completionTokens: 1, latencyMs: 1, success: true }));
    const logged = (await fixture.pg.query<{ model: string; quota_reserved: boolean }>("SELECT model,quota_reserved FROM token_logs WHERE owner_id=$1", [guestOwner])).rows[0];
    assert.deepEqual(logged, { model: "openrouter:vendor/lite-model", quota_reserved: true });
    const { quotaDay } = await import("../src/lib/quota");
    await fixture.pg.query("INSERT INTO model_call_quotas(owner_id,scope,model,day,attempts,legacy_used) VALUES ($1,'generation','openrouter:vendor/lite-model',$2,1,0)", [guestOwner, quotaDay()]);
    const quotaCfg = { ...await getAIConfig(guestOwner), keys: ["a", "b", "c"], keysSharedProject: false, enforceLimits: true, limits: { flash: 1, lite: 500 } };
    assert.deepEqual(await pickModels("narration", quotaCfg), { models: [], skipped: ["vendor/lite-model"] });
    await saveTextProviderSettings(guestOwner, { provider: "pollinations", model: "openai", apiKey: "synthetic-key", useLiveAI: true });
    await fixture.pg.query("UPDATE ai_settings SET pollinations_key_expires_at=now()-interval '1 minute' WHERE id=$1", [guestOwner]);
    const expiredView = await (await cookieContext(`chronicle_guest=${guest}`, () => oldSettingsGET())).json();
    assert.equal(expiredView.canUseLive, false);
    assert.equal(expiredView.textProvider, "pollinations");
    assert.ok(Date.parse(expiredView.textKeyExpiresAt) < Date.now());
  } finally {
    delete process.env.CHRONICLE_SECRET_KEYS;
    delete process.env.CHRONICLE_SECRET_ACTIVE_KEY;
    await fixture.close();
  }
});

test("provider settings reject unbounded input and incompatible key operations", async () => {
  const { parseTextProviderSettings } = await import("../src/lib/text-provider-settings");
  for (const body of [
    { provider: "unknown", model: "x" }, { provider: "openrouter", model: "" },
    { provider: ["gemini"], model: "valid" },
    { provider: "openrouter", model: "https://example.test bad" },
    { provider: "pollinations", model: "x".repeat(201) },
    { provider: "openrouter", model: "a/b", apiKey: "x".repeat(4097) },
    { provider: "openrouter", model: "a/b", apiKey: "secret", clearKey: true },
    { provider: "gemini", model: "", apiKey: "secret" },
    { provider: "gemini", model: "", useLiveAI: "true" },
    { provider: "gemini", model: "", ownerId: "other" },
  ]) assert.throws(() => parseTextProviderSettings(body));
  assert.deepEqual(parseTextProviderSettings({ provider: "openrouter", model: " vendor/model:free " }), { provider: "openrouter", model: "vendor/model:free" });
});
