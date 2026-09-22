import test from "node:test";
import assert from "node:assert/strict";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { auth } from "../src/lib/auth";
import { profileIdFromToken } from "../src/lib/guest-identity";

for (const endpoint of ["settings", "workspace"] as const) {
  test(`${endpoint} request admitted as account cannot silently retarget guest after logout during body read`, async () => {
    const fixture = await accountsDb();
    try {
      const account = await auth.register("a".repeat(64), "delayed", "correct horse battery staple");
      const owner = account.identity.profileId, guest = profileIdFromToken(account.guestToken)!;
      await fixture.pg.query("INSERT INTO ai_settings(id,daily_flash_limit) VALUES ($1,13),($2,17)", [owner, guest]);
      await fixture.pg.query("INSERT INTO workspace_preferences(id,display_name) VALUES ($1,'account name'),($2,'guest name')", [owner, guest]);
      const handler = endpoint === "settings"
        ? (await import("../src/app/api/settings/route")).POST
        : (await import("../src/app/api/workspace/route")).PATCH;
      const { POST: authAction } = await import("../src/app/api/auth/[action]/route");
      const { currentIdentity } = await import("../src/lib/identity");
      const cookie = `chronicle_guest=${account.guestToken}; chronicle_session=${account.sessionToken}`;
      let enterBody!: () => void, sendBody!: () => void;
      const bodyStarted = new Promise<void>(resolve => { enterBody = resolve; });
      const bodyReady = new Promise<void>(resolve => { sendBody = resolve; });
      const payload = JSON.stringify(endpoint === "settings" ? { dailyFlashLimit: 42 } : { displayName: "late request" });
      const body = new ReadableStream<Uint8Array>({ async pull(controller) {
        enterBody(); await bodyReady;
        controller.enqueue(new TextEncoder().encode(payload)); controller.close();
      } }, { highWaterMark: 0 });
      const pending = cookieContext(cookie, () => handler(new Request(`https://game.test/api/${endpoint}`, {
        method: endpoint === "settings" ? "POST" : "PATCH",
        headers: { "content-type": "application/json" }, body, duplex: "half",
      } as RequestInit)));
      await bodyStarted;
      assert.deepEqual((await fixture.pg.query<{ owner_id: string }>("SELECT owner_id FROM owner_activity")).rows, [{ owner_id: owner }]);
      try {
        const logout = await authAction(new Request("https://game.test/api/auth/logout", {
          method: "POST", headers: { cookie, origin: "https://game.test", "content-type": "application/json" }, body: "{}",
        }), { params: Promise.resolve({ action: "logout" }) });
        assert.equal(logout.status, 200);
        const otherRequest = await cookieContext(cookie, currentIdentity);
        assert.equal(otherRequest.kind, "guest");
        assert.equal(otherRequest.profileId, guest);
      } finally { sendBody(); }
      const response = await pending;
      assert.equal(response.status, 401);
      assert.equal((await response.json()).code, "IDENTITY_CHANGED");
      const settings = await fixture.pg.query<{ id: string; daily_flash_limit: number }>("SELECT id,daily_flash_limit FROM ai_settings");
      assert.equal(settings.rows.find(row => row.id === owner)?.daily_flash_limit, 13);
      assert.equal(settings.rows.find(row => row.id === guest)?.daily_flash_limit, 17);
      const workspace = await fixture.pg.query<{ id: string; display_name: string }>("SELECT id,display_name FROM workspace_preferences");
      assert.equal(workspace.rows.find(row => row.id === owner)?.display_name, "account name");
      assert.equal(workspace.rows.find(row => row.id === guest)?.display_name, "guest name");
      assert.equal((await fixture.pg.query<{ n: number }>("SELECT count(*)::int n FROM owner_activity")).rows[0].n, 0);
      // This scope is consistency-only, not a cache or a block on a later valid guest request.
      const newGuestRequest = await cookieContext(`chronicle_guest=${account.guestToken}`, () => handler(new Request(`https://game.test/api/${endpoint}`, {
        method: endpoint === "settings" ? "POST" : "PATCH", headers: { "content-type": "application/json" }, body: payload,
      })));
      assert.equal(newGuestRequest.status, 200);
    } finally { await fixture.close(); }
  });
}

test("developer settings admitted as admin cannot retarget guest after logout during body read", async () => {
  const fixture = await accountsDb();
  try {
    const account = await auth.register("b".repeat(64), "adminrequest", "correct horse battery staple");
    const owner = account.identity.profileId, guest = profileIdFromToken(account.guestToken)!;
    process.env.CHRONICLE_ADMIN_ACCOUNT_IDS = account.identity.account!.id;
    await fixture.pg.query("INSERT INTO ai_settings(id,typesafe_pilot_enabled) VALUES ($1,false),($2,false)", [owner, guest]);
    const { POST } = await import("../src/app/api/developer/typesafe/route");
    const { POST: authAction } = await import("../src/app/api/auth/[action]/route");
    const cookie = `chronicle_guest=${account.guestToken}; chronicle_session=${account.sessionToken}`;
    let enterBody!: () => void, sendBody!: () => void;
    const bodyStarted = new Promise<void>(resolve => { enterBody = resolve; });
    const bodyReady = new Promise<void>(resolve => { sendBody = resolve; });
    const body = new ReadableStream<Uint8Array>({ async pull(controller) {
      enterBody(); await bodyReady;
      controller.enqueue(new TextEncoder().encode('{"pilotEnabled":true}')); controller.close();
    } }, { highWaterMark: 0 });
    const pending = cookieContext(cookie, () => POST(new Request("https://game.test/api/developer/typesafe", {
      method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half",
    } as RequestInit)));
    await bodyStarted;
    try {
      const logout = await authAction(new Request("https://game.test/api/auth/logout", {
        method: "POST", headers: { cookie, origin: "https://game.test", "content-type": "application/json" }, body: "{}",
      }), { params: Promise.resolve({ action: "logout" }) });
      assert.equal(logout.status, 200);
    } finally { sendBody(); }
    const response = await pending;
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, "IDENTITY_CHANGED");
    const rows = await fixture.pg.query<{ typesafe_pilot_enabled: boolean }>("SELECT typesafe_pilot_enabled FROM ai_settings");
    assert.deepEqual(rows.rows.map(row => row.typesafe_pilot_enabled), [false, false]);
    assert.equal((await fixture.pg.query<{ n: number }>("SELECT count(*)::int n FROM owner_activity")).rows[0].n, 0);
    const denied = await cookieContext(`chronicle_guest=${account.guestToken}`, () => POST(new Request("https://game.test/api/developer/typesafe", { method: "POST", headers: { "content-type": "application/json" }, body: '{"pilotEnabled":true}' })));
    assert.equal(denied.status, 403);
  } finally { delete process.env.CHRONICLE_ADMIN_ACCOUNT_IDS; await fixture.close(); }
});
