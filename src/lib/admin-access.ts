import { pool } from "@/db";
import { currentIdentity } from "./identity";
import { isAdminAccount } from "./auth-policy";
import { HttpError } from "./http";

export async function requireAdmin() {
  const identity = await currentIdentity().catch(error => {
    if (error instanceof HttpError && error.status === 401) return null;
    throw error;
  });
  if (!identity?.isAdmin) throw new HttpError(403, "ADMIN_REQUIRED", "Доступно только администрации.");
  return identity;
}
/** Worker role comes from the database owner/account link, never request cookies. */
export async function isAdminOwner(profileId: string): Promise<boolean> {
  if (!process.env.CHRONICLE_ADMIN_ACCOUNT_IDS?.trim()) return false;
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM accounts WHERE profile_id=$1", [profileId]);
  return isAdminAccount(rows[0]?.id);
}
