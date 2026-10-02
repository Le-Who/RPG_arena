import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db";
import { accounts, consumedGuestProfiles, ownerActivity } from "../../src/db/schema";
import { OWNER_LOCK_NAMESPACE } from "../../src/lib/auth";

/** A retained registration profile is a valid account destination; a transferred guest
 * destination is permanently inaccessible. Recheck under the claim lock on apply. */
export async function assertLegacyProfileTarget(reader: Pick<typeof db, "select" | "execute">, profile: string, lock = false) {
  if (lock) {
    await reader.execute(sql`SELECT pg_advisory_xact_lock(${OWNER_LOCK_NAMESPACE},hashtext(${profile}))`);
    const active = await reader.select({ id: ownerActivity.id }).from(ownerActivity).where(eq(ownerActivity.ownerId, profile)).limit(1);
    if (active.length) throw new Error("Target profile has active work. Drain it before offline assignment.");
  }
  const [consumed] = await reader.select({ accountId: accounts.id }).from(consumedGuestProfiles)
    .leftJoin(accounts, eq(accounts.profileId, consumedGuestProfiles.profileId)).where(eq(consumedGuestProfiles.profileId, profile));
  if (consumed && !consumed.accountId) throw new Error("Target guest profile was consumed/transferred. Select the account's current profile instead.");
}
