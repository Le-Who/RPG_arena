import { createHash, randomBytes } from "node:crypto";

export const GUEST_COOKIE = "chronicle_guest";
export const GUEST_MAX_AGE = 60 * 60 * 24 * 365;
export function newGuestToken(): string { return randomBytes(32).toString("hex"); }
/** Only the digest is stored/exposed as an owner ID; it is not a credential. */
export function profileIdFromToken(token: string | undefined): string | null {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return `guest:${createHash("sha256").update(token).digest("hex")}`;
}
