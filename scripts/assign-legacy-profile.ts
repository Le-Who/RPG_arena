/** Offline administrator utility. Never expose legacy ownership claims as an HTTP route. */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, pool } from "../src/db";
import { gameSessions, workspacePreferences } from "../src/db/schema";
import { requireUuid } from "../src/lib/http";
import { applyLegacyProfileAssignment, assertLegacyProfileTarget } from "./lib/legacy-profile-target";

async function main() {
  const args = process.argv.slice(2);
  const profile = args.find(arg => arg.startsWith("--profile="))?.slice(10);
  if (!profile || !/^guest:[a-f0-9]{64}$/.test(profile)) throw new Error("Provide --profile=guest:<64 hex characters> from the chosen browser's /api/workspace response. Never pass its cookie.");
  const ids = args.filter(arg => arg.startsWith("--campaign=")).map(arg => requireUuid(arg.slice(11)));
  const includeSettings = args.includes("--include-settings");
  const allowPlaintext = args.includes("--allow-plaintext");
  if (!ids.length && !includeSettings) throw new Error("Select --campaign=<UUID> (repeatable), and/or --include-settings.");
  const [workspace] = await db.select().from(workspacePreferences).where(eq(workspacePreferences.id, profile));
  if (!workspace) throw new Error("Target profile does not exist. Open the site in its intended browser first.");
  await assertLegacyProfileTarget(db, profile);
  const selected = ids.length ? await db.select({ id: gameSessions.id, title: gameSessions.title }).from(gameSessions).where(and(inArray(gameSessions.id, ids), isNull(gameSessions.ownerId))) : [];
  if (selected.length !== new Set(ids).size) throw new Error("Every selected campaign must exist and have no owner. No changes made.");
  console.log(JSON.stringify({ profile, campaigns: selected, importLegacySettings: includeSettings, allowLegacyPlaintext: allowPlaintext, apply: args.includes("--apply") }, null, 2));
  if (!args.includes("--apply")) { console.log("Dry run. Add --apply after verifying the target browser and selected campaigns."); return; }
  await applyLegacyProfileAssignment({ profile, campaignIds: ids, includeSettings, allowPlaintext });
  console.log("Selected legacy data assigned privately. Original global/local settings retained; credentials were not printed.");
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Import failed"); process.exitCode = 1; }).finally(() => pool.end());
