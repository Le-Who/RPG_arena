// Opt-in only; bootstrap never inherits a user's database or provider credentials.
import "../helpers/test-environment";
import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type { AuthDatabase, AuthQuery } from "../../src/lib/auth";

for (const name of Object.keys(process.env)) if (name.startsWith("PG")) delete process.env[name];
delete process.env.CHRONICLE_PUBLIC_ORIGIN;
delete process.env.CHRONICLE_AUTH_TRUSTED_CLIENT_HEADER;

function barrier() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return { entered, release, async hold() { enter(); await released; } };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 8000);
    })]);
  } finally { clearTimeout(timer); }
}
type Hook = (sql: string, phase: "before" | "after") => Promise<void>;
function transport(pool: Pool, hook: Hook = async () => {}, onConnect?: (pid: number) => void): AuthDatabase {
  const wrap = (source: AuthQuery): AuthQuery => ({ async query(sql, values) {
    await hook(sql, "before");
    const result = await source.query(sql, values);
    await hook(sql, "after");
    return result as never;
  } });
  return { ...wrap(pool), async transaction(run) {
    const client = await pool.connect();
    try {
      onConnect?.((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await client.query("BEGIN");
      const result = await run(wrap(client));
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  } };
}
const token = () => randomBytes(32).toString("hex");
const oldPassword = "old fixture password 123";
const nextPassword = "new fixture password 456";
const otherPassword = "other fixture password 789";

test("native PostgreSQL auth races preserve password and principal authorization", {
  skip: process.env.CHRONICLE_RUN_AUTH_RACES_POSTGRES !== "1", timeout: 90000,
}, async t => {
  const schema = `auth_races_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, /^auth_races_[0-9a-f]{32}$/);
  const url = new URL("postgresql://chronicle_test:fixture-only@127.0.0.1:55439/chronicle_auth_test");
  const bootstrap = new Pool({ connectionString: url.toString() });
  const ownedPools: Pool[] = [];
  let createdSchema = false;
  try {
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    createdSchema = true;
    url.searchParams.set("options", `-csearch_path=${schema},public -cstatement_timeout=10000 -clock_timeout=8000`);
    process.env.DATABASE_URL = url.toString();
    const { pool } = await import("../../src/db");
    ownedPools.push(pool);
    const independent = new Pool({ connectionString: url.toString() });
    ownedPools.push(independent);
    // The fixture lacks native pgvector: immutable 0006 is skipped, not rewritten.
    for (const file of (await readdir("drizzle")).filter(x => /^\d{4}_.*\.sql$/.test(x) && !x.startsWith("0006_")).sort())
      await pool.query((await readFile(`drizzle/${file}`, "utf8")).replaceAll('"public".', `"${schema}".`));
    const { auth, createAuthService } = await import("../../src/lib/auth");
    const { profileIdFromToken } = await import("../../src/lib/guest-identity");
    const { tokenHash } = await import("../../src/lib/auth-policy");
    const { POST } = await import("../../src/app/api/auth/[action]/route");
    const seed = async () => {
      const login = `user_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
      const account = await auth.register(token(), login, oldPassword);
      const guest = token(), guestOwner = profileIdFromToken(guest)!, campaign = randomUUID();
      await pool.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,$2,'fixture','{}','{}')", [campaign, guestOwner]);
      await pool.query("INSERT INTO ai_settings(id) VALUES ($1),($2)", [account.identity.profileId, guestOwner]);
      return { account, login, guest, guestOwner, campaign };
    };
    const assertUnclaimed = async (guestOwner: string, campaign: string) => {
      assert.equal((await pool.query("SELECT owner_id FROM game_sessions WHERE id=$1", [campaign])).rows[0].owner_id, guestOwner);
      assert.equal((await pool.query("SELECT 1 FROM consumed_guest_profiles WHERE profile_id=$1", [guestOwner])).rows.length, 0);
      assert.equal((await pool.query("SELECT count(*)::int n FROM ai_settings WHERE id=$1", [guestOwner])).rows[0].n, 1);
    };
    await t.test("captured old login hash cannot mint a session after password-change commit", async () => {
      const { account, login, guest } = await seed();
      const gate = barrier();
      const racing = createAuthService(transport(independent, async (sql, phase) => {
        if (phase === "after" && sql === "SELECT * FROM accounts WHERE login=$1") await gate.hold();
      }));
      const pending = racing.login(guest, login, oldPassword);
      const rejection = assert.rejects(pending, { code: "INVALID_CREDENTIALS" });
      try {
        await bounded(gate.entered, "login captured old hash");
        await auth.changePassword(account.sessionToken, oldPassword, nextPassword);
      } finally { gate.release(); }
      await rejection;
      assert.equal((await pool.query("SELECT count(*)::int n FROM account_sessions WHERE account_id=$1", [account.identity.account!.id])).rows[0].n, 0);
      await assert.rejects(auth.login(guest, login, oldPassword), { code: "INVALID_CREDENTIALS" });
      assert.equal((await auth.login(guest, login, nextPassword)).identity.kind, "account");
    });
    await t.test("concurrent password changes revoke all captured sessions and accept only final password", async () => {
      const { account, login, guest } = await seed();
      const second = await auth.login(guest, login, oldPassword);
      const gate = barrier(); let reads = 0;
      const racing = createAuthService(transport(independent, async (sql, phase) => {
        if (phase === "after" && sql.startsWith("SELECT a.*") && ++reads === 1) await gate.hold();
      }));
      const losing = racing.changePassword(second.sessionToken, oldPassword, otherPassword);
      const rejection = assert.rejects(losing, { code: "IDENTITY_REQUIRED" });
      try {
        await bounded(gate.entered, "second password request captured session");
        await auth.changePassword(account.sessionToken, oldPassword, nextPassword);
      } finally { gate.release(); }
      await rejection;
      assert.equal((await auth.resolve(guest, account.sessionToken)).kind, "guest");
      assert.equal((await auth.resolve(guest, second.sessionToken)).kind, "guest");
      await assert.rejects(auth.login(guest, login, oldPassword), { code: "INVALID_CREDENTIALS" });
      await assert.rejects(auth.login(guest, login, otherPassword), { code: "INVALID_CREDENTIALS" });
      assert.equal((await auth.login(guest, login, nextPassword)).identity.kind, "account");
    });
    for (const revocation of ["logout", "logoutAll", "password", "expiry"] as const) {
      await t.test(`${revocation} committed before claim authorization cannot consume or transfer a guest`, async () => {
        const { account, guest, guestOwner, campaign } = await seed();
        const gate = barrier(); let reads = 0;
        const racing = createAuthService(transport(independent, async (sql, phase) => {
          if (phase === "after" && sql.startsWith("SELECT a.*") && ++reads === 1) await gate.hold();
        }));
        const pending = racing.adopt(guest, account.sessionToken);
        const rejection = assert.rejects(pending, { code: "IDENTITY_REQUIRED" });
        try {
          await bounded(gate.entered, "claim captured principal");
          if (revocation === "expiry") await pool.query("UPDATE account_sessions SET expires_at=clock_timestamp() WHERE token_hash=$1", [tokenHash(account.sessionToken)]);
          else if (revocation === "password") await auth.changePassword(account.sessionToken, oldPassword, nextPassword);
          else await auth[revocation](account.sessionToken);
        } finally { gate.release(); }
        try { await rejection; }
        catch (error) {
          const persisted = await pool.query("SELECT owner_id,(SELECT account_id FROM consumed_guest_profiles WHERE profile_id=$2) AS consumed_by FROM game_sessions WHERE id=$1", [campaign, guestOwner]);
          t.diagnostic(`${revocation} unauthorized claim persisted: ${JSON.stringify(persisted.rows[0])}`);
          throw error;
        }
        await assertUnclaimed(guestOwner, campaign);
      });
    }
    await t.test("authorized claim holds its principal until commit even while waiting for owner admission", async () => {
      const { account, guest, guestOwner, campaign } = await seed();
      const blocker = await independent.connect();
      let adoption: ReturnType<typeof auth.adopt> | undefined;
      let logout: Promise<void> | undefined;
      const ownerReached = barrier(); let logoutPid = 0, finished = false, blocked = false;
      const claiming = createAuthService(transport(pool, async (sql, phase) => {
        if (phase === "before" && sql === "SELECT pg_advisory_xact_lock(hashtext($1))") await ownerReached.hold();
      }));
      const revoking = createAuthService(transport(independent, undefined, pid => { logoutPid = pid; }));
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`owner:${account.identity.profileId}`]);
        adoption = claiming.adopt(guest, account.sessionToken);
        await bounded(ownerReached.entered, "claim authorized before owner wait");
        ownerReached.release();
        logout = revoking.logout(account.sessionToken).finally(() => { finished = true; });
        const deadline = Date.now() + 8000;
        while (!finished && Date.now() < deadline) {
          if (logoutPid) blocked = (await pool.query("SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked", [logoutPid])).rows[0].blocked;
          if (blocked) break;
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        assert.equal(blocked, true, "logout must wait on the claim's account lock, not revoke mid-claim");
        assert.equal(finished, false);
        await assertUnclaimed(guestOwner, campaign);
      } finally {
        ownerReached.release();
        await blocker.query("ROLLBACK"); blocker.release();
        await Promise.allSettled([adoption, logout]);
        if (finished && !blocked) {
          const persisted = await pool.query("SELECT owner_id,(SELECT account_id FROM consumed_guest_profiles WHERE profile_id=$2) AS consumed_by FROM game_sessions WHERE id=$1", [campaign, guestOwner]);
          t.diagnostic(`independently committed logout followed by claim: ${JSON.stringify(persisted.rows[0])}`);
        }
      }
      assert.equal((await pool.query("SELECT owner_id FROM game_sessions WHERE id=$1", [campaign])).rows[0].owner_id, account.identity.profileId);
      assert.equal((await pool.query("SELECT account_id FROM consumed_guest_profiles WHERE profile_id=$1", [guestOwner])).rows[0].account_id, account.identity.account!.id);
      assert.equal((await auth.resolve(token(), account.sessionToken)).kind, "guest");
    });
    await t.test("HTTP rejects revoked principal adoption without cookies or data changes; logout remains idempotent", async () => {
      const { account, guest, guestOwner, campaign } = await seed();
      await auth.logout(account.sessionToken);
      const request = (action: string, session = account.sessionToken) => new Request(`https://fixture.test/api/auth/${action}`, {
        method: "POST", headers: { origin: "https://fixture.test", cookie: `chronicle_guest=${guest}; chronicle_session=${session}`, "content-type": "application/json" }, body: "{}",
      });
      const response = await POST(request("adopt-guest"), { params: Promise.resolve({ action: "adopt-guest" }) });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal((await response.json()).code, "IDENTITY_REQUIRED");
      await assertUnclaimed(guestOwner, campaign);
      assert.equal((await pool.query("SELECT attempts FROM auth_rate_limits WHERE bucket=$1", [`adopt-guest:account:${account.identity.account!.id}`])).rows.length, 0);
      for (const session of [account.sessionToken, "invalid", token()]) {
        const loggedOut = await POST(request("logout", session), { params: Promise.resolve({ action: "logout" }) });
        assert.equal(loggedOut.status, 200);
        assert.equal(loggedOut.headers.get("cache-control"), "private, no-store");
        assert.match(loggedOut.headers.get("set-cookie")!, /chronicle_session=;[^,]*Max-Age=0/);
        assert.match(loggedOut.headers.get("set-cookie")!, /HttpOnly/);
      }
    });
  } finally {
    try {
      await Promise.all(ownedPools.map(pool => pool.end()));
      if (createdSchema) await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally { await bootstrap.end(); }
  }
});
