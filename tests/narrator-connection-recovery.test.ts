import test from "node:test";
import assert from "node:assert/strict";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { profileIdFromToken } from "../src/lib/guest-identity";
import { sealSecret, secretContext } from "../src/lib/secret-vault";

test("removing and replacing Gemini preserves narrator intent and restores autofill readiness", async () => {
  const f = await accountsDb();
  const token = "c".repeat(64), owner = profileIdFromToken(token)!;
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ test: Buffer.alloc(32, 65).toString("base64") });
  process.env.CHRONICLE_SECRET_ACTIVE_KEY = "test";
  try {
    const { POST } = await import("../src/app/api/settings/route");
    const { saveProviderConnection } = await import("../src/lib/text-provider-settings");
    const { getAIConfig } = await import("../src/lib/ai-settings");
    await f.pg.query("INSERT INTO ai_settings(id,keys,use_live_ai) VALUES ($1,$2::jsonb,true)", [owner, JSON.stringify([sealSecret("synthetic-old-gemini", secretContext(owner, "gemini"))])]);
    const response = await cookieContext(`chronicle_guest=${token}`, () => POST(new Request("http://localhost/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ removeIndex: [0] }) })));
    const removed = await response.json();
    assert.equal(response.status, 200);
    assert.equal(removed.canUseLive, false);
    assert.equal(removed.useLiveAI, true, "credential removal must not change narrator preference");
    await saveProviderConnection(owner, { provider: "gemini", apiKey: "synthetic-new-gemini" });
    assert.equal((await getAIConfig(owner)).canUseLive, true, "the same config gates story autofill and turns");
    await f.pg.query("UPDATE ai_settings SET use_live_ai=false WHERE id=$1", [owner]);
    await saveProviderConnection(owner, { provider: "gemini", apiKey: "synthetic-another-gemini" });
    assert.equal((await getAIConfig(owner)).canUseLive, false, "an intentional off preference stays off");
  } finally {
    delete process.env.CHRONICLE_SECRET_KEYS; delete process.env.CHRONICLE_SECRET_ACTIVE_KEY;
    await f.close();
  }
});

test("an unrelated broken Gemini key does not block the selected external narrator", async () => {
  const f = await accountsDb();
  const owner = "guest:external-recovery";
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ test: Buffer.alloc(32, 65).toString("base64") });
  process.env.CHRONICLE_SECRET_ACTIVE_KEY = "test";
  try {
    const { getAIConfig, getRawSettingsRow } = await import("../src/lib/ai-settings");
    const { settingsView } = await import("../src/lib/settings-view");
    await f.pg.query("INSERT INTO ai_settings(id,keys,text_provider,text_model,openrouter_key,use_live_ai) VALUES ($1,$2::jsonb,'openrouter','vendor/story',$3,true)", [owner, JSON.stringify(["synthetic-legacy-gemini"]), sealSecret("synthetic-router", secretContext(owner, "text:openrouter"))]);
    const view = settingsView(await getRawSettingsRow(owner));
    assert.deepEqual(view.credentialIssues, ["gemini"]);
    assert.equal(view.canUseLive, true);
    const config = await getAIConfig(owner);
    assert.equal(config.canUseLive, true);
    assert.deepEqual(config.keys, []);
    assert.equal(config.embeddingsEnabled, false);
    await f.pg.query("UPDATE ai_settings SET text_provider='gemini' WHERE id=$1", [owner]);
    await assert.rejects(getAIConfig(owner), /ключ/i);
  } finally {
    delete process.env.CHRONICLE_SECRET_KEYS; delete process.env.CHRONICLE_SECRET_ACTIVE_KEY;
    await f.close();
  }
});
