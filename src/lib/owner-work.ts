import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { pool } from "@/db";
import { authDatabase, OWNER_LOCK_NAMESPACE } from "./auth";
import { currentIdentity } from "./identity";
import { HttpError, httpError } from "./http";

type Work = { id: string; ownerId: string; refs: number; active: boolean };
const workScope = new AsyncLocalStorage<Map<string, Work>>();
/** Durable activity is admitted under a short owner transaction lock shared with claims.
 * No connection, transaction or session lock survives admission (transaction-pooler safe).
 * No automatic expiry: process crashes fail closed for transfers until an operator drains
 * ALL web/worker processes and removes orphan rows. Ordinary play/login remains available.
 * Nested/streamed work owns a reference until its promise finishes. */
export async function withOwnerWork<T>(ownerId: string, run: () => Promise<T>): Promise<T> {
  const inherited = workScope.getStore();
  let work = inherited?.get(ownerId);
  if (!work?.active) {
    const id = randomUUID();
    await authDatabase.transaction(async tx => {
      await tx.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [OWNER_LOCK_NAMESPACE, ownerId]);
      await tx.query("INSERT INTO owner_activity(id,owner_id) VALUES ($1,$2)", [id, ownerId]);
    });
    work = { id, ownerId, refs: 0, active: true };
  }
  work.refs++;
  const context = new Map(inherited); context.set(ownerId, work);
  try { return await workScope.run(context, run); }
  finally {
    if (--work.refs === 0) {
      work.active = false;
      // Failure to clean up must block later transfers, not turn a committed game action
      // into an apparent failure/retry. Recovery is explicitly fail-closed.
      await pool.query("DELETE FROM owner_activity WHERE id=$1", [work.id]).catch(() => { console.warn("owner_activity_cleanup_failed"); });
    }
  }
}
export async function withCurrentIdentityWork<T>(run: () => Promise<T>): Promise<T> {
  const before = await currentIdentity();
  return withOwnerWork(before.profileId, async () => {
    const current = await currentIdentity();
    if (current.profileId !== before.profileId || current.account?.id !== before.account?.id) throw new HttpError(401, "IDENTITY_CHANGED", "Профиль изменился. Обновите страницу.");
    return run();
  });
}
export function withIdentityWork<A extends unknown[]>(handler: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try { return await withCurrentIdentityWork(() => handler(...args)); }
    catch (error) { return httpError(error); }
  };
}
export async function withCampaignOwnerWork<T>(sessionId: string, expectedOwner: string | undefined, run: () => Promise<T>): Promise<T> {
  const before = await pool.query<{ owner_id: string }>("SELECT owner_id FROM game_sessions WHERE id=$1", [sessionId]);
  const owner = expectedOwner ?? before.rows[0]?.owner_id;
  if (!owner) throw new HttpError(404, "NOT_FOUND", "Кампания не найдена.");
  return withOwnerWork(owner, async () => {
    const current = await pool.query<{ owner_id: string }>("SELECT owner_id FROM game_sessions WHERE id=$1", [sessionId]);
    if (current.rows[0]?.owner_id !== owner) throw new HttpError(409, "OWNER_CHANGED", "OWNER_CHANGED: владелец кампании изменился.");
    return run();
  });
}
