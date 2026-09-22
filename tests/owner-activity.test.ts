import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { auth } from "../src/lib/auth";
import { profileIdFromToken } from "../src/lib/guest-identity";

test("failed activity cleanup leaves a durable transfer block, not a play/login outage", async () => {
  const f = await accountsDb();
  const { pool } = await import("../src/db");
  const { withOwnerWork } = await import("../src/lib/owner-work");
  const guest = "4".repeat(64), owner = profileIdFromToken(guest)!;
  const warning = mock.method(console, "warn", () => {});
  try {
    const query = mock.method(pool, "query", async (sql: unknown, values?: unknown[]) => {
      if (typeof sql === "string" && sql.startsWith("DELETE FROM owner_activity")) throw new Error("synthetic cleanup outage");
      return f.run(sql as string, values);
    });
    try { assert.equal(await withOwnerWork(owner, async () => "committed"), "committed"); }
    finally { query.mock.restore(); }
    await f.pg.query("UPDATE owner_activity SET created_at='2000-01-01'");
    assert.equal((await f.pg.query<{ n: number }>("SELECT count(*)::int n FROM owner_activity")).rows[0].n, 1);
    await assert.rejects(() => auth.register(guest, "orphaned", "correct horse battery staple"), /OWNER_BUSY/);
    const account = await auth.register("5".repeat(64), "existing", "correct horse battery staple");
    assert.equal((await auth.login(guest, "existing", "correct horse battery staple")).identity.kind, "account");
    await assert.rejects(() => auth.adopt(guest, account.sessionToken), /OWNER_BUSY/);
    const id = randomUUID();
    await f.pg.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,$2,'before','{}','{}')", [id, owner]);
    const { PATCH } = await import("../src/app/api/sessions/[id]/route");
    const response = await cookieContext(`chronicle_guest=${guest}`, () => PATCH(new Request("https://game.test", { method: "PATCH", headers: { "content-type": "application/json" }, body: '{"title":"after"}' }), { params: Promise.resolve({ id }) }));
    assert.equal(response.status, 200);
    assert.equal((await f.pg.query<{ title: string }>("SELECT title FROM game_sessions WHERE id=$1", [id])).rows[0].title, "after");
    assert.equal((await f.pg.query<{ n: number }>("SELECT count(*)::int n FROM owner_activity")).rows[0].n, 1, "normal work removes its own activity only, never the orphan");
  } finally { warning.mock.restore(); await f.close(); }
});

test("proxy repairs consumed guest cookies without granting access and keeps health independent", async () => {
  const f = await accountsDb();
  try {
    const { NextRequest } = await import("next/server");
    const { proxy } = await import("../src/proxy");
    const guest = "6".repeat(64);
    const a = await auth.register(guest, "claimed", "correct horse battery staple");
    const response = await proxy(new NextRequest("https://game.test/", { headers: { cookie: `chronicle_guest=${guest}` } }));
    const token = response.cookies.get("chronicle_guest")?.value;
    assert.ok(token);
    assert.notEqual(token, guest);
    assert.notEqual((await auth.resolve(token)).profileId, a.identity.profileId);
    assert.equal(response.headers.get("x-middleware-request-cookie"), `chronicle_guest=${token}`);
    await f.pg.exec("DROP TABLE consumed_guest_profiles");
    const health = await proxy(new NextRequest("https://game.test/api/health", { headers: { cookie: `chronicle_guest=${guest}` } }));
    assert.equal(health.status, 200);
    assert.equal(health.cookies.getAll().length, 0);
  } finally { await f.close(); }
});

test("unsafe APIs reject same-site sibling origins before identity/storage access", async () => {
  const { NextRequest } = await import("next/server");
  const { proxy } = await import("../src/proxy");
  const response = await proxy(new NextRequest("https://game.test/api/sessions/00000000-0000-4000-8000-000000000001/memory/reindex", { method: "POST", headers: { origin: "https://sibling.game.test", "sec-fetch-site": "same-site" } }));
  assert.equal(response.status, 403);
});

test("initial and repaired guest cookies are Secure in production even behind an HTTP-origin proxy", async () => {
  const fixture = await accountsDb();
  const environmentName: string = "NODE_ENV", previous = process.env[environmentName];
  try {
    const { NextRequest } = await import("next/server");
    const { proxy } = await import("../src/proxy");
    const oldGuest = "c".repeat(64);
    await auth.register(oldGuest, "cookieflags", "correct horse battery staple");
    process.env[environmentName] = "production";
    for (const cookie of [undefined, `chronicle_guest=${oldGuest}`]) {
      const response = await proxy(new NextRequest("http://game.test/", { headers: cookie ? { cookie } : {} }));
      assert.match(response.headers.get("set-cookie") ?? "", /; Secure(?:;|$)/i);
      assert.match(response.headers.get("set-cookie") ?? "", /; HttpOnly(?:;|$)/i);
      assert.match(response.headers.get("set-cookie") ?? "", /SameSite=lax/i);
    }
  } finally {
    if (previous === undefined) delete process.env[environmentName]; else process.env[environmentName] = previous;
    await fixture.close();
  }
});
