import { createHash } from "node:crypto";
import type { TurnLease } from "./turn-admission";
import { runSearchQuery } from "./search-database";

const forbidden = /^(?:apiKey|keys|authorization|cookie|narrativeGuardKey|typesafeKey|password)$/i;
/** Only explicitly assembled diagnostic inputs belong here, never provider headers/config. */
export function boundedNarrativeDiagnostic(value: Record<string, unknown>) {
  let truncated = false;
  function clean(v: unknown, depth = 0): unknown {
    if (depth > 14) { truncated = true; return "[depth limit]"; }
    if (typeof v === "string") { if (v.length > 12000) truncated = true; return v.slice(0, 12000); }
    if (Array.isArray(v)) { if (v.length > 100) truncated = true; return v.slice(0, 100).map(x => clean(x, depth + 1)); }
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([key]) => !forbidden.test(key)).map(([key, x]) => [key, clean(x, depth + 1)]));
    return v;
  }
  const cleaned = clean(value) as Record<string, unknown>;
  const encoded = JSON.stringify(cleaned);
  if (Buffer.byteLength(encoded, "utf8") > 256000) return { version: 1, truncated: true, detailedPayloadOmitted: true,
    contentSha256: createHash("sha256").update(encoded).digest("hex"), decision: cleaned.decision, reason: cleaned.reason };
  return { ...cleaned, version: 1, truncated };
}

export async function recordNarrativeAttempt(lease: Pick<TurnLease, "token" | "sessionId" | "requestId" | "baseTurn">, payload: Record<string, unknown>) {
  try {
    const { pool } = await import("@/db");
    await runSearchQuery(pool, { text: `INSERT INTO narrative_attempts(id,session_id,request_id,turn_number,payload)
      VALUES($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT(id) DO UPDATE SET payload=narrative_attempts.payload || EXCLUDED.payload ||
        jsonb_build_object('truncated',coalesce((narrative_attempts.payload->>'truncated')::boolean,false) OR coalesce((EXCLUDED.payload->>'truncated')::boolean,false)), updated_at=now()`,
      values: [lease.token, lease.sessionId, lease.requestId, lease.baseTurn + 1, JSON.stringify(boundedNarrativeDiagnostic(payload))] }, Date.now() + 500);
  } catch { console.warn("narrative_diagnostics_write_failed"); }
}

export async function finishNarrativeAttempt(lease: Pick<TurnLease, "token">, outcome: "completed" | "failed", code: string | null, timings: unknown) {
  try {
    const { pool } = await import("@/db");
    await runSearchQuery(pool, { text: "UPDATE narrative_attempts SET outcome=$2, payload=payload || ($3::jsonb - 'truncated') || CASE WHEN payload->>'decision'='pending' THEN jsonb_build_object('decision','not_reached') ELSE '{}'::jsonb END, updated_at=now() WHERE id=$1",
      values: [lease.token, outcome, JSON.stringify(boundedNarrativeDiagnostic({ finalCode: code, timings }))] }, Date.now() + 500);
  } catch { console.warn("narrative_diagnostics_finish_failed"); }
}

/** Schedule after the response; bounded cleanup is never needed to accept a turn. */
export async function pruneNarrativeDiagnostics() {
  try {
    const { pool } = await import("@/db");
    await runSearchQuery(pool, { text: "DELETE FROM narrative_attempts WHERE id IN (SELECT id FROM narrative_attempts WHERE created_at < now() - interval '30 days' ORDER BY created_at LIMIT 100)", values: [] }, Date.now() + 1000);
  } catch { console.warn("narrative_diagnostics_cleanup_failed"); }
}

export async function readNarrativeAttempts(sessionId: string, before?: string) {
  const { pool } = await import("@/db");
  const rows = await runSearchQuery(pool, { text: `SELECT id,request_id,turn_number,outcome,payload,created_at,updated_at FROM narrative_attempts
    WHERE session_id=$1 AND created_at >= now() - interval '30 days'
      AND ($2::uuid IS NULL OR (created_at,id) < (SELECT created_at,id FROM narrative_attempts WHERE id=$2 AND session_id=$1))
    ORDER BY created_at DESC,id DESC LIMIT 21`, values: [sessionId, before ?? null] }, Date.now() + 2000);
  return { attempts: rows.slice(0, 20), nextCursor: rows.length > 20 ? rows[19].id : null };
}
