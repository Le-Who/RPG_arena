/** Offline administrator utility. Never expose legacy ownership claims as an HTTP route. */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, pool } from "../src/db";
import { aiSettings, gameSessions, tokenLogs, workspacePreferences } from "../src/db/schema";
import { requireUuid } from "../src/lib/http";

async function main() {
  const args = process.argv.slice(2);
  const profile = args.find(arg => arg.startsWith("--profile="))?.slice(10);
  if (!profile || !/^guest:[a-f0-9]{64}$/.test(profile)) throw new Error("Provide --profile=guest:<64 hex characters> from the chosen browser's /api/workspace response. Never pass its cookie.");
  const ids = args.filter(arg => arg.startsWith("--campaign=")).map(arg => requireUuid(arg.slice(11)));
  const includeSettings = args.includes("--include-settings");
  if (!ids.length && !includeSettings) throw new Error("Select --campaign=<UUID> (repeatable), and/or --include-settings.");
  const [workspace] = await db.select().from(workspacePreferences).where(eq(workspacePreferences.id, profile));
  if (!workspace) throw new Error("Target profile does not exist. Open the site in its intended browser first.");
  const selected = ids.length ? await db.select({ id: gameSessions.id, title: gameSessions.title }).from(gameSessions).where(and(inArray(gameSessions.id, ids), isNull(gameSessions.ownerId))) : [];
  if (selected.length !== new Set(ids).size) throw new Error("Every selected campaign must exist and have no owner. No changes made.");
  console.log(JSON.stringify({ profile, campaigns: selected, importLegacySettings: includeSettings, apply: args.includes("--apply") }, null, 2));
  if (!args.includes("--apply")) { console.log("Dry run. Add --apply after verifying the target browser and selected campaigns."); return; }
  await db.transaction(async tx => {
    if (includeSettings) {
      await tx.insert(aiSettings).values({ id: profile }).onConflictDoNothing();
      const [target] = await tx.select().from(aiSettings).where(eq(aiSettings.id, profile)).for("update");
      if (target?.keys?.length || target?.typesafeKey) throw new Error("Target already has credentials. Import refused to avoid overwriting them.");
      const [legacyAI] = await tx.select().from(aiSettings).where(eq(aiSettings.id, "global"));
      const [legacyWorkspace] = await tx.select().from(workspacePreferences).where(eq(workspacePreferences.id, "local"));
      if (legacyAI) {
        const imported = { ...legacyAI, id: profile, updatedAt: new Date() };
        await tx.insert(aiSettings).values(imported).onConflictDoUpdate({ target: aiSettings.id, set: imported });
      }
      if (legacyWorkspace) await tx.update(workspacePreferences).set({ displayName: legacyWorkspace.displayName, favorites: legacyWorkspace.favorites, reading: legacyWorkspace.reading, updatedAt: new Date() }).where(eq(workspacePreferences.id, profile));
    }
    if (ids.length) {
      const assigned = await tx.update(gameSessions).set({ ownerId: profile, visibility: "private" }).where(and(inArray(gameSessions.id, ids), isNull(gameSessions.ownerId))).returning({ id: gameSessions.id });
      if (assigned.length !== selected.length) throw new Error("Ownership changed concurrently; import rolled back.");
      await tx.update(tokenLogs).set({ ownerId: profile }).where(and(inArray(tokenLogs.sessionId, ids), isNull(tokenLogs.ownerId)));
    }
  });
  console.log("Selected legacy data assigned privately. Original global/local settings retained; credentials were not printed.");
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Import failed"); process.exitCode = 1; }).finally(() => pool.end());
