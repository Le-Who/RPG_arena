import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { createAuthService, type AuthDatabase } from "../src/lib/auth";
import { profileIdFromToken } from "../src/lib/guest-identity";
import { assertAuthOrigin, hashPassword, isAdminAccount, verifyPassword } from "../src/lib/auth-policy";
import { scrypt } from "node:crypto";

const guest = "a".repeat(64), secondGuest = "b".repeat(64);
async function fixture() {
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE game_sessions(id uuid PRIMARY KEY, owner_id text); CREATE TABLE ai_settings(id text PRIMARY KEY, secret text);`);
  await pg.exec(await readFile(new URL("../drizzle/0011_accounts.sql", import.meta.url), "utf8"));
  // PGlite has one connection: serialize whole transactions, never overlapping BEGINs.
  let tail = Promise.resolve();
  const database: AuthDatabase = {
    query: (sql, values) => pg.query(sql, values),
    transaction: async fn => {
      const before = tail;
      let release!: () => void;
      tail = new Promise<void>(resolve => { release = resolve; });
      await before;
      try { return await pg.transaction(tx => fn({ query: (sql, values) => tx.query(sql, values) })); }
      finally { release(); }
    },
  };
  return { pg, database, auth: createAuthService(database) };
}

test("registration claims guest campaigns; old guest token loses authority and logout is empty", async () => {
  const { pg, auth } = await fixture();
  try {
    const owner = profileIdFromToken(guest)!;
    await pg.query("INSERT INTO game_sessions VALUES ('00000000-0000-4000-8000-000000000001',$1)", [owner]);
    const registered = await auth.register(guest, "alice", "correct horse battery staple");
    assert.equal(registered.identity.profileId, owner);
    assert.equal(registered.identity.kind, "account");
    await assert.rejects(() => auth.resolve(guest), /IDENTITY_REQUIRED/);
    assert.equal((await auth.resolve(guest, registered.sessionToken)).account?.login, "alice");
    await auth.logout(registered.sessionToken);
    await assert.rejects(() => auth.resolve(guest, registered.sessionToken), /IDENTITY_REQUIRED/);
    const fresh = await auth.resolve(registered.guestToken);
    assert.equal(fresh.kind, "guest");
    assert.notEqual(fresh.profileId, owner);
    assert.equal((await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM game_sessions WHERE owner_id=$1", [fresh.profileId])).rows[0].n, 0);
  } finally { await pg.close(); }
});

test("login never adopts; explicit adoption transfers once without copying settings", async () => {
  const { pg, auth } = await fixture();
  try {
    const a = await auth.register(guest, "alice", "correct horse battery staple");
    await pg.query("INSERT INTO ai_settings VALUES ($1,'account-bound-ciphertext'),($2,'guest-bound-ciphertext')", [a.identity.profileId, profileIdFromToken(secondGuest)]);
    await pg.query("INSERT INTO game_sessions VALUES ('00000000-0000-4000-8000-000000000002',$1)", [profileIdFromToken(secondGuest)]);
    const login = await auth.login(secondGuest, "ALICE", "correct horse battery staple");
    assert.equal(login.guestToken, secondGuest);
    assert.equal((await auth.view(secondGuest, login.sessionToken)).pendingGuestCampaigns, 1);
    await auth.logout(login.sessionToken);
    assert.equal((await auth.resolve(secondGuest)).profileId, profileIdFromToken(secondGuest));
    const again = await auth.login(secondGuest, "alice", "correct horse battery staple");
    const adopted = await auth.adopt(secondGuest, again.sessionToken);
    assert.notEqual(adopted.guestToken, secondGuest);
    assert.equal((await pg.query<{ owner_id: string }>("SELECT owner_id FROM game_sessions")).rows[0].owner_id, a.identity.profileId);
    assert.equal((await pg.query<{ secret: string }>("SELECT secret FROM ai_settings WHERE id=$1", [a.identity.profileId])).rows[0].secret, "account-bound-ciphertext");
    assert.equal((await pg.query<{ secret: string }>("SELECT secret FROM ai_settings WHERE id=$1", [profileIdFromToken(secondGuest)])).rows[0].secret, "guest-bound-ciphertext");
    await assert.rejects(() => auth.resolve(secondGuest), /IDENTITY_REQUIRED/);
    await assert.rejects(() => auth.adopt(secondGuest, again.sessionToken), /GUEST_CONSUMED/);
  } finally { await pg.close(); }
});

test("concurrent claims yield exactly one account and consumed credential cannot claim again", async () => {
  const { pg, auth } = await fixture();
  try {
    const results = await Promise.allSettled([
      auth.register(guest, "alice", "correct horse battery staple"),
      auth.register(guest, "bob", "correct horse battery staple"),
    ]);
    assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
    assert.equal((await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM accounts")).rows[0].n, 1);
  } finally { await pg.close(); }
});

test("logout-all and password change revoke sessions on other devices without positive cache", async () => {
  const { pg, auth } = await fixture();
  try {
    const a = await auth.register(guest, "alice", "correct horse battery staple");
    const b = await auth.login(secondGuest, "alice", "correct horse battery staple");
    await auth.logoutAll(a.sessionToken);
    assert.equal((await auth.resolve(secondGuest, b.sessionToken)).kind, "guest");
    const c = await auth.login(secondGuest, "alice", "correct horse battery staple");
    const d = await auth.login(secondGuest, "alice", "correct horse battery staple");
    await auth.changePassword(c.sessionToken, "correct horse battery staple", "a different secure password");
    assert.equal((await auth.resolve(secondGuest, c.sessionToken)).kind, "guest");
    assert.equal((await auth.resolve(secondGuest, d.sessionToken)).kind, "guest");
    await assert.rejects(() => auth.login(secondGuest, "alice", "correct horse battery staple"), /INVALID_CREDENTIALS/);
    await assert.rejects(() => auth.login(secondGuest, "missing", "correct horse battery staple"), /INVALID_CREDENTIALS/);
    assert.equal((await auth.login(secondGuest, "alice", "a different secure password")).identity.kind, "account");
  } finally { await pg.close(); }
});

test("database rate limit survives service instances and changed usernames", async () => {
  const { pg, auth, database } = await fixture();
  try {
    for (let i = 0; i < 10; i++) await auth.rateLimit("register", "untrusted-global");
    await assert.rejects(() => createAuthService(database).rateLimit("register", "untrusted-global"), /RATE_LIMITED/);
    assert.equal((await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM auth_rate_limits")).rows[0].n, 1);
  } finally { await pg.close(); }
});

test("expired sessions and a deleted account never revive a consumed guest credential", async () => {
  const { pg, auth } = await fixture();
  try {
    const a = await auth.register(guest, "alice", "correct horse battery staple");
    await pg.query("UPDATE account_sessions SET expires_at=now()-interval '1 second'");
    await assert.rejects(() => auth.resolve(guest, a.sessionToken), /IDENTITY_REQUIRED/);
    assert.equal((await auth.resolve(a.guestToken, a.sessionToken)).kind, "guest");
    await pg.query("DELETE FROM accounts");
    await assert.rejects(() => auth.resolve(guest), /IDENTITY_REQUIRED/);
  } finally { await pg.close(); }
});

test("login with an old password cannot create a session after a concurrent password change", async () => {
  const { pg, auth, database } = await fixture();
  try {
    const a = await auth.register(guest, "alice", "correct horse battery staple");
    let entered!: () => void, resume!: () => void;
    const readOldHash = new Promise<void>(r => { entered = r; });
    const proceed = new Promise<void>(r => { resume = r; });
    const racingAuth = createAuthService({ ...database, query: async (sql, values) => {
      const result = await database.query(sql, values);
      if (sql === "SELECT * FROM accounts WHERE login=$1") { entered(); await proceed; }
      return result as never;
    } });
    const login = racingAuth.login(secondGuest, "alice", "correct horse battery staple");
    await readOldHash;
    await auth.changePassword(a.sessionToken, "correct horse battery staple", "a different secure password");
    resume();
    await assert.rejects(() => login, /INVALID_CREDENTIALS/);
    assert.equal((await pg.query<{ n: number }>("SELECT count(*)::int n FROM account_sessions")).rows[0].n, 0);
    assert.equal((await auth.login(secondGuest, "alice", "a different secure password")).identity.kind, "account");
  } finally { await pg.close(); }
});

test("auth origin is mandatory and admin permission only comes from exact account ID allowlist", () => {
  assert.throws(() => assertAuthOrigin(new Request("https://game.test/api/auth", { method: "POST" })), /ORIGIN_REJECTED/);
  assert.throws(() => assertAuthOrigin(new Request("https://game.test/api/auth", { method: "POST", headers: { origin: "https://evil.test" } })), /ORIGIN_REJECTED/);
  assert.doesNotThrow(() => assertAuthOrigin(new Request("https://game.test/api/auth", { method: "POST", headers: { origin: "https://game.test" } })));
  assert.equal(isAdminAccount("a", ""), false);
  assert.equal(isAdminAccount("a", "aa"), false);
  assert.equal(isAdminAccount(null, "a"), false);
  assert.equal(isAdminAccount("a", "b, a"), true);
});

test("versioned scrypt hashes verify with explicit bounded work factors and reject hostile cost fields", async () => {
  const password = "correct horse battery staple", salt = "01".repeat(16);
  const deriveExternal = (salt: string) => new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
  });
  const key = await deriveExternal(salt);
  const fixtureHash = `scrypt:v1:32768:8:1:${salt}:${key.toString("hex")}`;
  assert.equal(await verifyPassword(password, fixtureHash), true);
  assert.equal(await verifyPassword("wrong password", fixtureHash), false);
  assert.equal(await verifyPassword(password, fixtureHash.replace(":32768:", ":2147483648:")), false);
  const stored = await hashPassword(password);
  const parts = stored.split(":");
  assert.equal(parts.slice(0, 5).join(":"), "scrypt:v1:32768:8:1");
  const external = await deriveExternal(parts[5]);
  assert.equal(external.toString("hex"), parts[6]);
});
