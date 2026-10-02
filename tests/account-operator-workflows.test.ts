import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { auth } from "../src/lib/auth";
import { profileIdFromToken } from "../src/lib/guest-identity";

test("offline legacy assignment rejects transferred guests but accepts account-retained profile IDs", async () => {
  const f = await accountsDb();
  try {
    const { db } = await import("../src/db");
    const { assertLegacyProfileTarget } = await import("../scripts/lib/legacy-profile-target");
    const a = await auth.register("7".repeat(64), "legacyowner", "correct horse battery staple");
    const guest = "8".repeat(64), target = profileIdFromToken(guest)!;
    await assertLegacyProfileTarget(db, target);
    await auth.adopt(guest, a.sessionToken);
    await assert.rejects(() => assertLegacyProfileTarget(db, target), /consumed/);
    await db.transaction(tx => assertLegacyProfileTarget(tx, a.identity.profileId, true));
  } finally { await f.close(); }
});

test("isolated smoke admin requires explicit allowlisted fixture identity and authenticates actual admin API", async () => {
  const f = await accountsDb();
  try {
    const { createIsolatedAdminSession } = await import("../scripts/lib/isolated-admin");
    const profile = profileIdFromToken("9".repeat(64))!;
    await assert.rejects(() => createIsolatedAdminSession(profile), /ARENA_ISOLATED_TEST_DB/);
    process.env.ARENA_ISOLATED_TEST_DB = "1";
    process.env.SMOKE_ADMIN_ACCOUNT_ID = randomUUID();
    await assert.rejects(() => createIsolatedAdminSession(profile), /allowlist/);
    process.env.CHRONICLE_ADMIN_ACCOUNT_IDS = process.env.SMOKE_ADMIN_ACCOUNT_ID;
    const session = await createIsolatedAdminSession(profile);
    const identity = await auth.resolve(session.guestToken, session.sessionToken);
    assert.equal(identity.isAdmin, true);
    assert.equal(identity.profileId, profile);
    const { GET } = await import("../src/app/api/developer/typesafe/route");
    const response = await cookieContext(`chronicle_guest=${session.guestToken}; chronicle_session=${session.sessionToken}`, GET);
    assert.equal(response.status, 200);
    await assert.rejects(() => createIsolatedAdminSession(profile), /already|duplicate/);
  } finally {
    delete process.env.ARENA_ISOLATED_TEST_DB; delete process.env.SMOKE_ADMIN_ACCOUNT_ID; delete process.env.CHRONICLE_ADMIN_ACCOUNT_IDS;
    await f.close();
  }
});
