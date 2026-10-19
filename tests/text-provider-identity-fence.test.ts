import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { accountsDb, cookieContext } from "./helpers/accounts-db";

for (const method of ["GET", "POST"] as const) test(`text provider ${method} rejects an identity revoked after its settings ${method === "GET" ? "read" : "write"}`, async () => {
  const fixture = await accountsDb();
  try {
    const { auth } = await import("../src/lib/auth");
    const { pool } = await import("../src/db");
    const route = await import("../src/app/api/settings/text-provider/route");
    const account = await auth.register("4".repeat(64), `provider-fence-${method.toLowerCase()}`, "correct horse battery staple");
    await fixture.pg.query("INSERT INTO ai_settings(id,text_model) VALUES ($1,'private/account-model')", [account.identity.profileId]);
    let revoked = false;
    const query = mock.method(pool, "query", async (...args: Parameters<typeof fixture.run>) => {
      const text = typeof args[0] === "string" ? args[0] : args[0].text;
      const result = await fixture.run(...args);
      if (!revoked && (method === "GET" ? /^select .* from "ai_settings"/i.test(text) : text.startsWith('update "ai_settings"'))) {
        await fixture.pg.query("DELETE FROM account_sessions"); revoked = true;
      }
      return result;
    });
    try {
      const response = await cookieContext(`chronicle_guest=${account.guestToken}; chronicle_session=${account.sessionToken}`, () => method === "GET" ? route.GET()
        : route.POST(new Request("https://fixture.test/api/settings/text-provider", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "gemini", model: "private/account-selected" }) })));
      assert.equal(revoked, true, "revoke only after the actual route's settings operation completes");
      assert.equal(response.status, 401);
      const body = await response.json();
      assert.equal(body.code, "IDENTITY_CHANGED", "the fresh guest fallback cannot replace the admitted account");
      assert.equal(Object.hasOwn(body, "provider"), false); assert.equal(Object.hasOwn(body, "model"), false);
      assert.ok(!JSON.stringify(body).includes("private/account"));
      const rows = (await fixture.pg.query<{ id: string; text_model: string }>("SELECT id,text_model FROM ai_settings")).rows;
      assert.deepEqual(rows, [{ id: account.identity.profileId, text_model: method === "POST" ? "private/account-selected" : "private/account-model" }], "a committed account write never becomes a guest write");
      assert.equal((await fixture.pg.query<{ n: number }>("SELECT count(*)::int n FROM owner_activity")).rows[0].n, 0);
    } finally { query.mock.restore(); }
  } finally { await fixture.close(); }
});
