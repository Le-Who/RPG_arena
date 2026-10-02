import test from "node:test";
import assert from "node:assert/strict";
import { accountsDb } from "./helpers/accounts-db";
import { GUEST_COOKIE, profileIdFromToken } from "../src/lib/guest-identity";

test("real auth handlers require origin, issue private cookies, preserve guest on login and clear sessions on logout", async () => {
  const f = await accountsDb();
  try {
    const route = await import("../src/app/api/auth/[action]/route");
    const guest = "1".repeat(64);
    const call = (action: string, body: unknown, cookie = `${GUEST_COOKIE}=${guest}`, origin = "https://game.test") => route.POST(new Request(`https://game.test/api/auth/${action}`, { method: "POST", headers: { "content-type": "application/json", cookie, origin }, body: JSON.stringify(body) }), { params: Promise.resolve({ action }) });
    assert.equal((await call("register", { login: "alice", password: "correct horse battery staple" }, undefined, "https://evil.test")).status, 403);
    assert.equal((await f.pg.query<{ n: number }>("SELECT count(*)::int n FROM accounts")).rows[0].n, 0);
    const registered = await call("register", { login: "alice", password: "correct horse battery staple" });
    assert.equal(registered.status, 200);
    const response = await registered.json();
    assert.equal(response.identity.kind, "account");
    assert.equal(response.identity.capabilities.administration, false);
    assert.ok(!JSON.stringify(response).includes("password_hash"));
    const set = registered.headers.getSetCookie();
    assert.equal(set.length, 2);
    assert.ok(set.every(x => /HttpOnly/i.test(x) && /Secure/i.test(x) && /SameSite=Lax/i.test(x)));
    const sessionCookie = set.find(x => x.startsWith("chronicle_session="))!.split(";")[0];
    const freshGuestCookie = set.find(x => x.startsWith("chronicle_guest="))!.split(";")[0];
    assert.notEqual(freshGuestCookie, `${GUEST_COOKIE}=${guest}`);
    const rows = await f.pg.query<{ token_hash: string }>("SELECT token_hash FROM account_sessions");
    assert.notEqual(rows.rows[0].token_hash, sessionCookie.split("=")[1]);
    const me = await route.GET(new Request("https://game.test/api/auth/me", { headers: { cookie: `${freshGuestCookie}; ${sessionCookie}` } }), { params: Promise.resolve({ action: "me" }) });
    assert.equal((await me.json()).identity.account.login, "alice");
    const logout = await call("logout", {}, `${freshGuestCookie}; ${sessionCookie}`);
    assert.equal(logout.status, 200);
    assert.equal((await logout.json()).identity.kind, "guest");
    const rejectedOld = await route.GET(new Request("https://game.test/api/auth/me", { headers: { cookie: `${GUEST_COOKIE}=${guest}` } }), { params: Promise.resolve({ action: "me" }) });
    assert.equal(rejectedOld.status, 401);
    const login = await call("login", { login: "alice", password: "correct horse battery staple" }, freshGuestCookie);
    assert.equal((await login.json()).identity.guestProfileId, profileIdFromToken(freshGuestCookie.split("=")[1]));
    assert.equal(login.headers.getSetCookie().find(x => x.startsWith("chronicle_guest="))!.split(";")[0], freshGuestCookie);
  } finally { await f.close(); }
});

test("auth handler rate limit cannot be bypassed by changed logins or untrusted forwarded IPs", async () => {
  const f = await accountsDb();
  try {
    const { POST } = await import("../src/app/api/auth/[action]/route");
    for (let i = 0; i < 11; i++) {
      const response = await POST(new Request("https://game.test/api/auth/register", { method: "POST", headers: { origin: "https://game.test", "content-type": "application/json", "x-forwarded-for": `1.2.3.${i}`, cookie: `${GUEST_COOKIE}=${"2".repeat(64)}` }, body: JSON.stringify({ login: `user${i}`, password: "short" }) }), { params: Promise.resolve({ action: "register" }) });
      assert.equal(response.status, i < 10 ? 400 : 429);
    }
  } finally { await f.close(); }
});
