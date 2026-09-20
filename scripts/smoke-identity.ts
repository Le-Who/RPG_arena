import { eq, inArray } from "drizzle-orm";
import { db } from "../src/db";
import { aiSettings, tokenLogs, workerHeartbeats, workspacePreferences } from "../src/db/schema";
import { GUEST_COOKIE, newGuestToken, profileIdFromToken } from "../src/lib/guest-identity";

/** One disposable browser identity for the entire smoke run, including concurrent requests. */
const token = newGuestToken();
export const smokeOwnerId = profileIdFromToken(token)!;
const nativeFetch = globalThis.fetch;
export function smokeFetch(input: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cookie", `${GUEST_COOKIE}=${token}`);
  return nativeFetch(input, { ...init, headers });
}
export async function cleanupSmokeIdentity() {
  await db.delete(tokenLogs).where(eq(tokenLogs.ownerId, smokeOwnerId));
  await db.delete(aiSettings).where(eq(aiSettings.id, smokeOwnerId));
  await db.delete(workspacePreferences).where(eq(workspacePreferences.id, smokeOwnerId));
  await db.delete(workerHeartbeats).where(inArray(workerHeartbeats.id, [`memory:after:${smokeOwnerId}`, `memory:manual:${smokeOwnerId}`]));
}
