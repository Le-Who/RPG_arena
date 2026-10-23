import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { auth } from "../src/lib/auth";
import { withIdentityWork } from "../src/lib/owner-work";
import { withAdminAccess } from "../src/lib/admin-access";

for (const endpoint of ["sessions", "workspace", "performance"] as const) test(`${endpoint} GET rejects account revocation while its data is loading`, { timeout: 30_000 }, async () => {
  const f = await accountsDb();
  const { pool } = await import("../src/db");
  const oldAdmins = process.env.CHRONICLE_ADMIN_ACCOUNT_IDS;
  let enter!: () => void, release!: () => void, pending: Promise<Response> | undefined;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const resumed = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  try {
    const account = await auth.register("a".repeat(64), `reader${endpoint}`, "correct horse battery staple");
    process.env.CHRONICLE_ADMIN_ACCOUNT_IDS = account.identity.account!.id;
    await f.pg.query("INSERT INTO workspace_preferences(id,display_name) VALUES ($1,'Личное пространство')", [account.identity.profileId]);
    const handler = (endpoint === "sessions" ? (await import("../src/app/api/sessions/route")).GET
      : endpoint === "workspace" ? (await import("../src/app/api/workspace/route")).GET
      : (await import("../src/app/api/system/performance/route")).GET) as (request: Request) => Promise<Response>;
    const query = mock.method(pool, "query", (async (...args: Parameters<typeof f.run>) => {
      const sql = typeof args[0] === "string" ? args[0] : args[0].text;
      const result = await f.run(...args);
      const selected = endpoint === "sessions" ? sql.includes('from "game_sessions"')
        : endpoint === "workspace" ? sql.includes('from "workspace_preferences"') : sql.startsWith("SELECT metric, route");
      if (!held && selected) { held = true; enter(); await resumed; }
      return result;
    }) as never);
    try {
      const cookie = `chronicle_guest=${account.guestToken}; chronicle_session=${account.sessionToken}`;
      pending = cookieContext(cookie, () => handler(new Request(`https://game.test/api/${endpoint}`)));
      await entered;
      await auth.logout(account.sessionToken);
      release();
      const response = await pending;
      assert.equal(response.status, endpoint === "performance" ? 403 : 401);
      assert.equal((await response.json()).code, endpoint === "performance" ? "ADMIN_REQUIRED" : "IDENTITY_CHANGED");
      assert.deepEqual((await f.pg.query("SELECT owner_id FROM owner_activity")).rows, []);
    } finally { release(); await pending?.catch(() => {}); query.mock.restore(); }
  } finally {
    if (oldAdmins === undefined) delete process.env.CHRONICLE_ADMIN_ACCOUNT_IDS; else process.env.CHRONICLE_ADMIN_ACCOUNT_IDS = oldAdmins;
    await f.close();
  }
});

for (const administration of [false, true]) test(`${administration ? "admin" : "identity"} wrapper preserves a successful committed mutation after logout`, async () => {
  const f = await accountsDb();
  const oldAdmins = process.env.CHRONICLE_ADMIN_ACCOUNT_IDS;
  try {
    const account = await auth.register("a".repeat(64), "mutationowner", "correct horse battery staple");
    process.env.CHRONICLE_ADMIN_ACCOUNT_IDS = account.identity.account!.id;
    const mutation = async (_request: Request) => {
      await f.pg.query("INSERT INTO workspace_preferences(id,display_name) VALUES ($1,'Сохранённое изменение')", [account.identity.profileId]);
      await auth.logout(account.sessionToken);
      return Response.json({ ok: true });
    };
    const handler = administration ? withAdminAccess(mutation) : withIdentityWork(mutation);
    const response = await cookieContext(`chronicle_guest=${account.guestToken}; chronicle_session=${account.sessionToken}`,
      () => handler(new Request("https://game.test/api/mutation", { method: "POST" })));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual((await f.pg.query("SELECT display_name FROM workspace_preferences WHERE id=$1", [account.identity.profileId])).rows, [{ display_name: "Сохранённое изменение" }]);
    assert.equal((await auth.resolve(account.guestToken, account.sessionToken)).kind, "guest");
  } finally {
    if (oldAdmins === undefined) delete process.env.CHRONICLE_ADMIN_ACCOUNT_IDS; else process.env.CHRONICLE_ADMIN_ACCOUNT_IDS = oldAdmins;
    await f.close();
  }
});
