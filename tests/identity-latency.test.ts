import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { auth, createAuthService, type AuthDatabase } from "../src/lib/auth";
import { profileIdFromToken } from "../src/lib/guest-identity";

test("identity resolution reads account and guest revocation in one fresh query without password data", async () => {
  const fixture = await accountsDb();
  try {
    const account = await auth.register("a".repeat(64), "latency", "correct horse battery staple");
    const statements: string[] = [];
    const database: AuthDatabase = {
      async query<T extends Record<string, unknown>>(sql: string, values?: unknown[]) {
        statements.push(sql);
        const result = await fixture.run(sql, values);
        assert.ok(result.rows.every(row => !("password_hash" in row)), "identity reads do not load password hashes");
        return result as { rows: T[] };
      },
      async transaction() { throw new Error("identity reads must not open transactions"); },
    };
    const service = createAuthService(database);
    assert.deepEqual(await service.resolve(account.guestToken, account.sessionToken), account.identity);
    assert.equal(statements.length, 1, "one database roundtrip per fresh identity resolution");

    await auth.logout(account.sessionToken);
    statements.length = 0;
    const guest = await service.resolve(account.guestToken, account.sessionToken);
    assert.equal(guest.kind, "guest", "later reads must observe logout immediately");
    assert.equal(guest.profileId, profileIdFromToken(account.guestToken));
    assert.equal(statements.length, 1);

    statements.length = 0;
    await assert.rejects(() => service.resolve("a".repeat(64), account.sessionToken), /IDENTITY_REQUIRED/);
    assert.equal(statements.length, 1, "revoked sessions never recover consumed guest access");
    statements.length = 0;
    await assert.rejects(() => service.resolve("malformed", "malformed"), /IDENTITY_REQUIRED/);
    assert.equal(statements.length, 0, "invalid credentials need no database access");
  } finally { await fixture.close(); }
});

test("owner admission uses one database roundtrip and keeps nested work admitted until its last reference", async () => {
  const fixture = await accountsDb();
  const { pool } = await import("../src/db");
  const { withOwnerWork } = await import("../src/lib/owner-work");
  let releaseChild!: () => void;
  const childReady = new Promise<void>(resolve => { releaseChild = resolve; });
  let child: Promise<void> | undefined;
  let roundtrips = 0;
  const query = mock.method(pool, "query", async (sql: string, values?: unknown[]) => {
    roundtrips++;
    return fixture.run(sql, values);
  });
  const connect = mock.method(pool, "connect", async () => ({
    async query(sql: string, values?: unknown[]) { roundtrips++; return fixture.run(sql, values); },
    release() {},
  }));
  try {
    await withOwnerWork("guest:latency", async () => {
      assert.equal(roundtrips, 1, "admission commits its lock and activity row in one roundtrip");
      child = withOwnerWork("guest:latency", async () => { await childReady; });
      assert.equal(roundtrips, 1, "nested work reuses admission");
      assert.deepEqual((await fixture.pg.query("SELECT owner_id FROM owner_activity")).rows, [{ owner_id: "guest:latency" }]);
    });
    assert.equal(roundtrips, 1, "the child retains activity after the outer callback finishes");
    assert.equal((await fixture.pg.query("SELECT 1 FROM owner_activity")).rows.length, 1);
    releaseChild(); await child;
    assert.equal(roundtrips, 2, "the final reference performs one durable cleanup");
    assert.equal((await fixture.pg.query("SELECT 1 FROM owner_activity")).rows.length, 0);
  } finally {
    releaseChild(); await child;
    query.mock.restore(); connect.mock.restore(); await fixture.close();
  }
});

test("warm settings reads and saves keep bounded roundtrips for both guests and accounts", async t => {
  const fixture = await accountsDb();
  const { pool } = await import("../src/db");
  const { GET, POST } = await import("../src/app/api/settings/route");
  const readSettings: (request: Request) => Promise<Response> = GET;
  try {
    const account = await auth.register("b".repeat(64), "settingslatency", "correct horse battery staple");
    for (const [kind, cookie, owner] of [
      ["guest", `chronicle_guest=${account.guestToken}`, profileIdFromToken(account.guestToken)!],
      ["account", `chronicle_guest=${account.guestToken}; chronicle_session=${account.sessionToken}`, account.identity.profileId],
    ] as const) {
      assert.equal((await cookieContext(cookie, () => readSettings(new Request("https://game.test/api/settings")))).status, 200, "create a settings row before measuring warm operations");
      let roundtrips = 0;
      const record = async (...args: Parameters<typeof fixture.run>) => { roundtrips++; return fixture.run(...args); };
      const query = mock.method(pool, "query", record);
      const connect = mock.method(pool, "connect", async () => ({ query: record, release() {} }));
      try {
        assert.equal((await cookieContext(cookie, () => readSettings(new Request("https://game.test/api/settings")))).status, 200);
        const readRoundtrips = roundtrips;
        // Actual Next requests include a final fresh lookup to catch revocation
        // while data loads; mutations retain their existing admission boundary.
        assert.ok(readRoundtrips <= 7, `${kind} warm settings GET exceeded 7 database roundtrips: ${readRoundtrips}`);
        roundtrips = 0;
        const response = await cookieContext(cookie, () => POST(new Request("https://game.test/api/settings", {
          method: "POST", headers: { "content-type": "application/json" }, body: '{"dailyFlashLimit":42}',
        })));
        assert.equal(response.status, 200);
        assert.equal((await response.json()).dailyFlashLimit, 42);
        assert.ok(roundtrips <= 9, `${kind} warm settings POST exceeded 9 database roundtrips: ${roundtrips}`);
        assert.deepEqual((await fixture.pg.query("SELECT daily_flash_limit FROM ai_settings WHERE id=$1", [owner])).rows, [{ daily_flash_limit: 42 }]);
        t.diagnostic(`${kind}: warm settings GET=${readRoundtrips}, POST=${roundtrips} database roundtrips (route only)`);
      } finally { query.mock.restore(); connect.mock.restore(); }
    }
  } finally { await fixture.close(); }
});
