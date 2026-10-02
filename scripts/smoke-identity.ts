import { eq, inArray } from "drizzle-orm";
import { db } from "../src/db";
import { accounts, consumedGuestProfiles, aiSettings, tokenLogs, workerHeartbeats, workspacePreferences } from "../src/db/schema";
import { GUEST_COOKIE, newGuestToken, profileIdFromToken } from "../src/lib/guest-identity";
import { SESSION_COOKIE } from "../src/lib/auth-policy";
import { createIsolatedAdminSession } from "./lib/isolated-admin";

/** One disposable browser identity for the entire smoke run, including concurrent requests. */
let token = newGuestToken();
export const smokeOwnerId = profileIdFromToken(token)!;
let sessionToken: string | undefined;
const nativeFetch = globalThis.fetch;
export function smokeFetch(input: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cookie", `${GUEST_COOKIE}=${token}${sessionToken ? `; ${SESSION_COOKIE}=${sessionToken}` : ""}`);
  if (!["GET", "HEAD", "OPTIONS"].includes((init?.method ?? "GET").toUpperCase())) headers.set("Origin", process.env.CHRONICLE_PUBLIC_ORIGIN || new URL(input).origin);
  return nativeFetch(input, { ...init, headers });
}
export async function prepareAdminSmokeIdentity() {
  const result = await createIsolatedAdminSession(smokeOwnerId);
  sessionToken = result.sessionToken; token = result.guestToken;
}
export async function cleanupSmokeIdentity() {
  await db.delete(tokenLogs).where(eq(tokenLogs.ownerId, smokeOwnerId));
  await db.delete(aiSettings).where(eq(aiSettings.id, smokeOwnerId));
  await db.delete(workspacePreferences).where(eq(workspacePreferences.id, smokeOwnerId));
  await db.delete(workerHeartbeats).where(inArray(workerHeartbeats.id, [`memory:after:${smokeOwnerId}`, `memory:manual:${smokeOwnerId}`]));
  if (sessionToken) {
    await db.delete(consumedGuestProfiles).where(eq(consumedGuestProfiles.profileId, smokeOwnerId));
    await db.delete(accounts).where(eq(accounts.profileId, smokeOwnerId));
  }
}
