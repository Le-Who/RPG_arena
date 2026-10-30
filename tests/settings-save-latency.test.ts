import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { newGuestToken, profileIdFromToken } from "../src/lib/guest-identity";
import { auth } from "../src/lib/auth";
import { openSecret, secretContext } from "../src/lib/secret-vault";

test("unrelated settings save retains a Gemini connection committed after its initial read", async () => {
  const fixture = await accountsDb();
  const { pool } = await import("../src/db");
  const { POST } = await import("../src/app/api/settings/route");
  const { saveProviderConnection } = await import("../src/lib/text-provider-settings");
  const guest = newGuestToken(), ownerId = profileIdFromToken(guest)!;
  process.env.CHRONICLE_SECRET_ACTIVE_KEY = "race";
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ race: Buffer.alloc(32, 29).toString("base64") });
  await fixture.pg.query("INSERT INTO ai_settings(id) VALUES ($1)", [ownerId]);
  let connected = false;
  const query = mock.method(pool, "query", async (...args: Parameters<typeof fixture.run>) => {
    const sql = typeof args[0] === "string" ? args[0] : args[0].text;
    if (!connected && sql.startsWith('update "ai_settings"')) {
      connected = true;
      await saveProviderConnection(ownerId, { provider: "gemini", apiKey: "synthetic-concurrent-key" });
      await fixture.pg.query("UPDATE ai_settings SET daily_lite_limit=13,use_live_ai=true WHERE id=$1", [ownerId]);
    }
    return fixture.run(...args);
  });
  try {
    const response = await cookieContext(`chronicle_guest=${guest}`, () => POST(new Request("http://localhost/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: '{"dailyFlashLimit":42}',
    })));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).keysCount, 1);
    const saved = (await fixture.pg.query<{ keys: string[]; daily_flash_limit: number; daily_lite_limit: number; use_live_ai: boolean }>("SELECT keys,daily_flash_limit,daily_lite_limit,use_live_ai FROM ai_settings WHERE id=$1", [ownerId])).rows[0];
    assert.equal(saved.daily_flash_limit, 42);
    assert.equal(saved.keys.length, 1);
    assert.equal(saved.daily_lite_limit, 13);
    assert.equal(saved.use_live_ai, true);
    assert.equal(openSecret(saved.keys[0], secretContext(ownerId, "gemini")), "synthetic-concurrent-key");
  } finally {
    query.mock.restore(); await fixture.close();
    delete process.env.CHRONICLE_SECRET_ACTIVE_KEY; delete process.env.CHRONICLE_SECRET_KEYS;
  }
});

test("settings mutation returns committed canonical fields without re-reading settings", async () => {
  const fixture = await accountsDb();
  const { pool } = await import("../src/db");
  const { POST } = await import("../src/app/api/settings/route");
  const guest = newGuestToken(), ownerId = profileIdFromToken(guest)!;
  await fixture.pg.query("INSERT INTO ai_settings(id,openrouter_key,narrative_guard_key,text_provider,text_model,use_live_ai) VALUES ($1,$2,$3,'openrouter','vendor/model',true)", [ownerId, "unrelated-router-secret", "unrelated-narrative-secret"]);
  let settingsReads = 0;
  const query = mock.method(pool, "query", async (...args: Parameters<typeof fixture.run>) => {
    const sql = typeof args[0] === "string" ? args[0] : args[0].text;
    if (/^select .* from "ai_settings"/i.test(sql)) settingsReads++;
    return fixture.run(...args);
  });
  try {
    const response = await cookieContext(`chronicle_guest=${guest}`, () => POST(new Request("http://localhost/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dailyFlashLimit: 200000, routingProfile: "economy" }),
    })));
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.equal(saved.dailyFlashLimit, 100000);
    assert.equal(saved.routingProfile, "economy");
    assert.equal(saved.narrationModel, "gemini-3.5-flash-lite");
    assert.equal(saved.useLiveAI, true);
    assert.equal(saved.canUseLive, false, "legacy plaintext is not a usable live connection");
    assert.deepEqual(saved.credentialIssues, ["openrouter"]);
    assert.equal(saved.textProvider, "openrouter");
    assert.equal(settingsReads, 1, "use UPDATE RETURNING instead of selecting canonical settings again");
    assert.ok(!JSON.stringify(saved).includes("unrelated-router-secret"));
    assert.ok(!JSON.stringify(saved).includes("unrelated-narrative-secret"));
  } finally { query.mock.restore(); await fixture.close(); }
});

test("settings save preserves the final revocation fence without returning old account data", async () => {
  const fixture = await accountsDb();
  const { pool } = await import("../src/db");
  const { POST } = await import("../src/app/api/settings/route");
  try {
    const account = await auth.register("f".repeat(64), "late-revocation", "correct horse battery staple");
    await fixture.pg.query("INSERT INTO ai_settings(id) VALUES ($1)", [account.identity.profileId]);
    let revoked = false;
    const query = mock.method(pool, "query", async (...args: Parameters<typeof fixture.run>) => {
      const text = typeof args[0] === "string" ? args[0] : args[0].text;
      const result = await fixture.run(...args);
      if (text.startsWith('update "ai_settings"')) {
        await fixture.pg.query("DELETE FROM account_sessions"); revoked = true;
      }
      return result;
    });
    try {
      const response = await cookieContext(`chronicle_guest=${account.guestToken}; chronicle_session=${account.sessionToken}`, () => POST(new Request("https://game.test/api/settings", {
        method: "POST", headers: { "content-type": "application/json" }, body: '{"dailyFlashLimit":42}',
      })));
      assert.equal(revoked, true);
      assert.equal(response.status, 401);
      assert.equal("dailyFlashLimit" in await response.json(), false);
    } finally { query.mock.restore(); }
  } finally { await fixture.close(); }
});
