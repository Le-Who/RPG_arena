import { cookies } from "next/headers";
import { desc, eq, getTableColumns } from "drizzle-orm";
import { db } from "@/db";
import { gameSessions } from "@/db/schema";
import { auth } from "@/lib/auth";
import { GUEST_COOKIE } from "@/lib/guest-identity";
import { SESSION_COOKIE } from "@/lib/auth-policy";
import { assertAdmittedIdentity } from "@/lib/identity-scope";
import { currentIdentity } from "@/lib/identity";
import { withIdentityWork } from "@/lib/owner-work";
import { getRawSettingsRow } from "@/lib/ai-settings";
import { settingsView } from "@/lib/settings-view";
import { getWorkspacePreferences } from "@/lib/workspace-preferences";

export const dynamic = "force-dynamic";

async function handleGET() {
  const jar = await cookies();
  const identity = await auth.view(jar.get(GUEST_COOKIE)?.value, jar.get(SESSION_COOKIE)?.value);
  assertAdmittedIdentity(identity);
  const ownerId = identity.profileId;
  const { scenarioPrompt: _omit, ...columns } = getTableColumns(gameSessions);
  const [sessions, rawSettings, workspace] = await Promise.all([
    db.select(columns).from(gameSessions).where(eq(gameSessions.ownerId, ownerId)).orderBy(desc(gameSessions.updatedAt)).limit(100),
    getRawSettingsRow(ownerId),
    getWorkspacePreferences(ownerId),
  ]);
  // Revalidate after loading, just as the former final /auth/me request did.
  // The owner activity blocks transfers; fresh identity resolution also catches revocation.
  await currentIdentity();
  return Response.json({ ok: true, identity, sessions, settings: settingsView(rawSettings), workspace }, { headers: { "Cache-Control": "private, no-store" } });
}

export const GET = withIdentityWork(handleGET);
