import test from "node:test";
import assert from "node:assert/strict";
import { accountsDb, cookieContext } from "./helpers/accounts-db";

for (const boundary of ["body", "catalogue"] as const) test(`visual preferences reject logout during ${boundary} before modifying saved settings`, async t => {
  const fixture = await accountsDb();
  const { auth } = await import("../src/lib/auth");
  const { POST } = await import("../src/app/api/settings/visual-provider/route");
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  let pending: Promise<Response> | undefined;
  try {
    const account = await auth.register("6".repeat(64), `visual-revoke-${boundary}`, "correct horse battery staple");
    const owner = account.identity.profileId;
    await fixture.pg.query("INSERT INTO ai_settings(id,visual_enabled,visual_model) VALUES ($1,false,'fixture/original')", [owner]);
    const before = (await fixture.pg.query("SELECT * FROM ai_settings WHERE id=$1", [owner])).rows[0];
    const payload = boundary === "body"
      ? { enabled: false, provider: "pollinations", accountSource: "application", model: "fixture/changed" }
      : { enabled: true, provider: "openrouter", accountSource: "personal", model: "fixture/revocation-image", endpoint: "fixture" };
    const body = boundary === "body" ? new ReadableStream<Uint8Array>({ async pull(controller) {
      enter(); await released; controller.enqueue(new TextEncoder().encode(JSON.stringify(payload))); controller.close();
    } }, { highWaterMark: 0 }) : JSON.stringify(payload);
    t.mock.method(globalThis, "fetch", async () => {
      assert.equal(boundary, "catalogue");
      enter(); await released;
      return Response.json({ id: "fixture/revocation-image", endpoints: [{ provider_tag: "fixture", supported_parameters: { input_references: { type: "range", min: 0, max: 0 } } }] });
    });
    pending = cookieContext(`chronicle_guest=${account.guestToken}; chronicle_session=${account.sessionToken}`, () => POST(new Request("https://game.test/api/settings/visual-provider", {
      method: "POST", headers: { "Content-Type": "application/json" }, body, duplex: "half",
    } as RequestInit)));
    await entered;
    await auth.logout(account.sessionToken);
    release();
    const response = await pending;
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, "IDENTITY_CHANGED");
    assert.deepEqual((await fixture.pg.query("SELECT * FROM ai_settings WHERE id=$1", [owner])).rows[0], before);
    assert.equal((await fixture.pg.query<{ n: number }>("SELECT count(*)::int AS n FROM ai_settings")).rows[0].n, 1);
    assert.equal((await fixture.pg.query<{ n: number }>("SELECT count(*)::int AS n FROM owner_activity")).rows[0].n, 0);
  } finally { release(); await pending?.catch(() => {}); await fixture.close(); }
});
