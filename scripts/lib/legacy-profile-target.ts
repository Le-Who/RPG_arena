import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../src/db";
import { accounts, aiSettings, consumedGuestProfiles, gameSessions, ownerActivity, tokenLogs, workspacePreferences } from "../../src/db/schema";
import { OWNER_LOCK_NAMESPACE } from "../../src/lib/auth";
import { hasStoredSettingsCredentials, rebindSettingsSecrets } from "../../src/lib/secret-vault";

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

/** Apply the offline utility's previewed selection; every write shares the claim lock
 * and transaction. The CLI owns argument validation, dry-run selection and output. */
export async function applyLegacyProfileAssignment(input: { profile: string; campaignIds: string[]; includeSettings: boolean; allowPlaintext: boolean }) {
  const { profile, campaignIds, includeSettings, allowPlaintext } = input;
  await db.transaction(async tx => {
    await assertLegacyProfileTarget(tx, profile, true);
    if (includeSettings) {
      await tx.insert(aiSettings).values({ id: profile }).onConflictDoNothing();
      const [target] = await tx.select().from(aiSettings).where(eq(aiSettings.id, profile)).for("update");
      if (target && hasStoredSettingsCredentials(target)) throw new Error("Target already has credentials. Import refused to avoid overwriting them.");
      const [legacyAI] = await tx.select().from(aiSettings).where(eq(aiSettings.id, "global"));
      const [legacyWorkspace] = await tx.select().from(workspacePreferences).where(eq(workspacePreferences.id, "local"));
      if (legacyAI) {
        const rebound = rebindSettingsSecrets(legacyAI, profile, { allowPlaintext });
        const imported = { ...legacyAI, ...rebound, id: profile, updatedAt: new Date() };
        await tx.insert(aiSettings).values(imported).onConflictDoUpdate({ target: aiSettings.id, set: imported });
      }
      if (legacyWorkspace) await tx.update(workspacePreferences).set({ displayName: legacyWorkspace.displayName, favorites: legacyWorkspace.favorites, reading: legacyWorkspace.reading, updatedAt: new Date() }).where(eq(workspacePreferences.id, profile));
    }
    if (campaignIds.length) {
      const assigned = await tx.update(gameSessions).set({ ownerId: profile, visibility: "private" }).where(and(inArray(gameSessions.id, campaignIds), isNull(gameSessions.ownerId))).returning({ id: gameSessions.id });
      if (assigned.length !== new Set(campaignIds).size) throw new Error("Ownership changed concurrently; import rolled back.");
      await tx.update(tokenLogs).set({ ownerId: profile }).where(and(inArray(tokenLogs.sessionId, campaignIds), isNull(tokenLogs.ownerId)));
    }
  });
}
