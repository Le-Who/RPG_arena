import test from "node:test";
import assert from "node:assert/strict";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { portableFixture } from "./helpers/portable-fixture";
import { createPortableDocument } from "../src/lib/campaign-portable";

test("campaign import revalidates its account after a delayed portable request body", async () => {
  const fixture = await accountsDb();
  let release!: () => void, entered!: () => void;
  const bodyReady = new Promise<void>(resolve => { release = resolve; });
  const bodyStarted = new Promise<void>(resolve => { entered = resolve; });
  let pending: Promise<Response> | undefined;
  try {
    const { auth } = await import("../src/lib/auth");
    const { POST } = await import("../src/app/api/sessions/import/route");
    const account = await auth.register("3".repeat(64), "import-revocation", "correct horse battery staple");
    const document = createPortableDocument(portableFixture());
    const body = new ReadableStream<Uint8Array>({ async pull(controller) {
      entered(); await bodyReady;
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ requestId: "revoked-import", document }))); controller.close();
    } }, { highWaterMark: 0 });
    pending = cookieContext(`chronicle_guest=${account.guestToken}; chronicle_session=${account.sessionToken}`, () => POST(new Request("https://game.test/api/sessions/import", {
      method: "POST", headers: { "Content-Type": "application/json" }, body, duplex: "half",
    } as RequestInit)));
    await bodyStarted;
    await auth.logout(account.sessionToken);
    release();
    const response = await pending;
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, "IDENTITY_CHANGED");
    assert.deepEqual((await fixture.pg.query(`SELECT
      (SELECT count(*)::int FROM game_sessions) AS campaigns,
      (SELECT count(*)::int FROM campaign_imports) AS imports,
      (SELECT count(*)::int FROM owner_activity) AS activity`)).rows, [{ campaigns: 0, imports: 0, activity: 0 }]);
  } finally { release(); await pending?.catch(() => {}); await fixture.close(); }
});
