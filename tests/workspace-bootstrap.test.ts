import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { profileIdFromToken } from "../src/lib/guest-identity";

test("public page proxy is usable without database availability; API still repairs consumed guests", async () => {
  const { auth } = await import("../src/lib/auth");
  const { NextRequest } = await import("next/server");
  const { proxy } = await import("../src/proxy");
  const lookup = mock.method(auth, "guestProfile", async () => { throw new Error("database unavailable"); });
  try {
    for (const path of ["/", "/worlds", "/settings", "/api/settings", "/api/workspace", "/api/sessions"]) {
      const response = await proxy(new NextRequest(`https://game.test${path}`, { headers: { cookie: `chronicle_guest=${"d".repeat(64)}` } }));
      assert.equal(response.status, 200);
      assert.equal(response.cookies.getAll().length, 0);
    }
    assert.equal(lookup.mock.callCount(), 0, "ordinary requests must not independently rotate a guest while bootstrap is pending");
    await assert.rejects(() => proxy(new NextRequest("https://game.test/api/bootstrap", { headers: { cookie: `chronicle_guest=${"d".repeat(64)}` } })), /database unavailable/);
  } finally { lookup.mock.restore(); }
});

test("only bootstrap repairs a consumed guest; other APIs deny it without a competing cookie", async () => {
  const f = await accountsDb();
  try {
    const { auth } = await import("../src/lib/auth");
    const { NextRequest } = await import("next/server");
    const { proxy } = await import("../src/proxy");
    const settings = await import("../src/app/api/settings/route");
    const oldGuest = "9".repeat(64);
    const account = await auth.register(oldGuest, "bootstrap-cookie", "correct horse battery staple");
    const request = new NextRequest("https://game.test/api/settings", { headers: { cookie: `chronicle_guest=${oldGuest}` } });
    const ordinary = await proxy(request);
    assert.equal(ordinary.cookies.getAll().length, 0);
    const denied = await cookieContext(`chronicle_guest=${oldGuest}`, settings.GET);
    assert.equal(denied.status, 401);
    const repaired = await proxy(new NextRequest("https://game.test/api/bootstrap", { headers: { cookie: `chronicle_guest=${oldGuest}` } }));
    const token = repaired.cookies.get("chronicle_guest")?.value;
    assert.ok(token);
    assert.notEqual(token, oldGuest);
    assert.notEqual((await auth.resolve(token)).profileId, account.identity.profileId);
  } finally { await f.close(); }
});

test("bootstrap returns a single owner-bound snapshot and never exposes stored credentials", async () => {
  const f = await accountsDb();
  try {
    const { GET } = await import("../src/app/api/bootstrap/route");
    const guest = "a".repeat(64), owner = profileIdFromToken(guest)!;
    const other = profileIdFromToken("b".repeat(64))!;
    for (const [id, name, limit] of [[owner, "Мой профиль", 37], [other, "Чужой профиль", 999]] as const) {
      await f.pg.query("INSERT INTO workspace_preferences(id,display_name) VALUES ($1,$2)", [id, name]);
      await f.pg.query("INSERT INTO ai_settings(id,daily_flash_limit) VALUES ($1,$2)", [id, limit]);
      await f.pg.query("INSERT INTO game_sessions(title,owner_id,character,world_state) VALUES ($1,$2,'{}','{}')", [name, id]);
    }
    const response = await cookieContext(`chronicle_guest=${guest}`, () => GET());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.match(response.headers.get("server-timing")!, /app;.*dur=/);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.identity.profileId, owner);
    assert.equal(body.workspace.id, owner);
    assert.equal(body.workspace.displayName, "Мой профиль");
    assert.equal(body.settings.dailyFlashLimit, 37);
    assert.deepEqual(body.sessions.map((s: { ownerId: string }) => s.ownerId), [owner]);
    for (const privateField of ["password_hash", "pollinationsKey", "openrouterKey", "scenarioPrompt"]) assert.equal(JSON.stringify(body).includes(`\"${privateField}\"`), false);
    assert.equal((await f.pg.query<{ n: number }>("SELECT count(*)::int n FROM owner_activity")).rows[0].n, 0);
  } finally { await f.close(); }
});

test("bootstrap rejects a guest consumed during loading instead of returning the old profile", async () => {
  const f = await accountsDb();
  const { pool } = await import("../src/db");
  try {
    const { GET } = await import("../src/app/api/bootstrap/route");
    const guest = "c".repeat(64), owner = profileIdFromToken(guest)!;
    const accountId = "10000000-0000-4000-8000-000000000001";
    await f.pg.query("INSERT INTO accounts(id,login,profile_id,password_hash) VALUES ($1,'new-owner','other','synthetic')", [accountId]);
    let consumed = false;
    const lookup = mock.method(pool, "query", async (query: unknown, values?: unknown[]) => {
      const text = typeof query === "string" ? query : (query as { text: string }).text;
      const result = await f.run(query as string, values);
      if (!consumed && text.includes('from "game_sessions"')) {
        consumed = true;
        await f.pg.query("INSERT INTO consumed_guest_profiles(profile_id,account_id) VALUES ($1,$2)", [owner, accountId]);
      }
      return result;
    });
    try {
      const response = await cookieContext(`chronicle_guest=${guest}`, () => GET());
      assert.equal(consumed, true);
      assert.equal(response.status, 401);
      assert.equal("sessions" in await response.json(), false);
    } finally { lookup.mock.restore(); }
  } finally { await f.close(); }
});

test("reading an existing workspace does not rewrite preferences", async () => {
  const f = await accountsDb();
  const { pool } = await import("../src/db");
  try {
    const { GET } = await import("../src/app/api/workspace/route");
    const guest = "e".repeat(64), owner = profileIdFromToken(guest)!;
    await f.pg.query("INSERT INTO workspace_preferences(id,display_name) VALUES ($1,'Сохранённое имя')", [owner]);
    const writes: string[] = [];
    const lookup = mock.method(pool, "query", async (query: unknown, values?: unknown[]) => {
      const text = typeof query === "string" ? query : (query as { text: string }).text;
      if (/insert into "workspace_preferences"/i.test(text)) writes.push(text);
      return f.run(query as string, values);
    });
    try {
      const response = await cookieContext(`chronicle_guest=${guest}`, () => GET());
      assert.equal((await response.json()).displayName, "Сохранённое имя");
      assert.equal(writes.length, 0);
    } finally { lookup.mock.restore(); }
  } finally { await f.close(); }
});
