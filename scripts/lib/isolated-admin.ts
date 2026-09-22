import { authDatabase, lockGuestClaim } from "../../src/lib/auth";
import { hashPassword, isAdminAccount, newSessionToken, tokenHash } from "../../src/lib/auth-policy";
import { newGuestToken } from "../../src/lib/guest-identity";
import { requireUuid } from "../../src/lib/http";

/** Explicit isolated fixture, never an HTTP privilege-assignment capability. The same
 * chosen account UUID must be allowlisted in the separately running web server. */
export async function createIsolatedAdminSession(profileId: string) {
  if (process.env.ARENA_ISOLATED_TEST_DB !== "1") throw new Error("Admin smoke requires ARENA_ISOLATED_TEST_DB=1.");
  const id = requireUuid(process.env.SMOKE_ADMIN_ACCOUNT_ID ?? "");
  if (!isAdminAccount(id)) throw new Error("Set SMOKE_ADMIN_ACCOUNT_ID and include it in CHRONICLE_ADMIN_ACCOUNT_IDS allowlist in BOTH isolated web and smoke processes.");
  if (!/^guest:[a-f0-9]{64}$/.test(profileId)) throw new Error("Invalid synthetic profile ID.");
  const sessionToken = newSessionToken(), passwordHash = await hashPassword(newSessionToken());
  await authDatabase.transaction(async tx => {
    await lockGuestClaim(tx, profileId);
    const inserted = await tx.query("INSERT INTO accounts(id,login,profile_id,password_hash) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id", [id, `smoke_${id.replaceAll("-", "")}`, profileId, passwordHash]);
    if (!inserted.rows.length) throw new Error("Smoke account/profile already exists; use an unused isolated fixture ID.");
    await tx.query("INSERT INTO consumed_guest_profiles(profile_id,account_id) VALUES ($1,$2)", [profileId, id]);
    await tx.query("INSERT INTO account_sessions(token_hash,account_id,expires_at) VALUES ($1,$2,now()+interval '1 hour')", [tokenHash(sessionToken), id]);
  });
  return { sessionToken, guestToken: newGuestToken() };
}
