import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { newGuestToken, profileIdFromToken } from "../src/lib/guest-identity";
import { auth } from "../src/lib/auth";

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
    assert.equal(saved.canUseLive, true);
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
