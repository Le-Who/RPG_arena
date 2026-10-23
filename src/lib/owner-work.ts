import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { pool } from "@/db";
import { OWNER_LOCK_NAMESPACE } from "./auth";
import { currentIdentity } from "./identity";
import { HttpError, httpError } from "./http";
import { withAdmittedIdentity } from "./identity-scope";
import { measureRequestPhase, withRequestDiagnostics } from "./request-diagnostics";

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
    // The materialized, volatile lock CTE must run before the insert. Autocommit
    // holds its transaction lock through the durable insert, then releases both
    // the lock and connection before work starts, using one database roundtrip.
    await measureRequestPhase("admission", () => pool.query(`WITH admission_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock($1,hashtext($2))
    ) INSERT INTO owner_activity(id,owner_id) SELECT $3,$2 FROM admission_lock`, [OWNER_LOCK_NAMESPACE, ownerId, id]));
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
      await measureRequestPhase("cleanup", () => pool.query("DELETE FROM owner_activity WHERE id=$1", [work.id]).catch(() => { console.warn("owner_activity_cleanup_failed"); }));
    }
  }
}
export async function withCurrentIdentityWork<T>(run: () => Promise<T>): Promise<T> {
  const before = await measureRequestPhase("identity", () => currentIdentity());
  return withOwnerWork(before.profileId, async () => {
    const current = await measureRequestPhase("identity", () => currentIdentity());
    if (current.profileId !== before.profileId || current.account?.id !== before.account?.id) throw new HttpError(401, "IDENTITY_CHANGED", "Профиль изменился. Обновите страницу.");
    return withAdmittedIdentity(current, run);
  });
}
/** Admission, handler and owner cleanup until Response is ready; excludes stream completion. */
export function withServerTiming(response: Response, started: number): Response {
  try {
    const duration = Math.max(0, performance.now() - started).toFixed(1);
    const previous = response.headers.get("Server-Timing");
    response.headers.set("Server-Timing", `${previous ? `${previous}, ` : ""}app;desc="response-ready";dur=${duration}`);
  } catch { /* Immutable headers: optional timing never changes request semantics. */ }
  return response;
}
export function withIdentityWork<A extends unknown[]>(handler: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    const started = performance.now();
    let response: Response;
    response = await withRequestDiagnostics(async () => {
      try { return await withCurrentIdentityWork(async () => {
        const result = await measureRequestPhase("handler", () => handler(...args));
        const request = args[0];
        if (result.ok && request instanceof Request && (request.method === "GET" || request.method === "HEAD")) await currentIdentity();
        return result;
      }); }
      catch (error) { return httpError(error); }
    });
    return withServerTiming(response, started);
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
