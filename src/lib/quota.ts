import { sql } from "drizzle-orm";
import { db } from "@/db";
import { QuotaAdmissionError } from "./quota-errors";

export type QuotaScope = "generation" | "embedding";
type BudgetConfig = { ownerId?: string; keys: string[]; limits: { flash: number; lite: number }; enforceLimits?: boolean; keysSharedProject?: boolean; dailyEmbeddingLimit?: number };
export function quotaTimezone(zone = process.env.CHRONICLE_QUOTA_TIMEZONE ?? "America/Los_Angeles") {
  try { new Intl.DateTimeFormat("en", { timeZone: zone }).format(); }
  catch { throw new Error("INVALID_QUOTA_TIMEZONE"); }
  return zone;
}
export function quotaDay(now = new Date(), zone = quotaTimezone()) {
  quotaTimezone(zone);
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
export function quotaCap(cfg: BudgetConfig, scope: QuotaScope, model: string) {
  const limit = scope === "embedding" ? cfg.dailyEmbeddingLimit ?? 5000 : model.includes("lite") ? cfg.limits.lite : cfg.limits.flash;
  const cap = limit * (cfg.keysSharedProject === false ? Math.max(1, new Set(cfg.keys).size) : 1);
  if (!Number.isSafeInteger(cap) || cap < 0) throw new Error("INVALID_QUOTA_CAP");
  return cap;
}
function legacyWhere(owner: string, scope: QuotaScope, day: string, zone: string) {
  return sql`owner_id = ${owner} AND NOT quota_reserved
    AND (CASE WHEN model LIKE '%embedding%' THEN 'embedding' ELSE 'generation' END) = ${scope}
    AND created_at >= (${day}::date::timestamp AT TIME ZONE ${zone}) AT TIME ZONE 'UTC'
    AND created_at < ((${day}::date + 1)::timestamp AT TIME ZONE ${zone}) AT TIME ZONE 'UTC'`;
}

/** One committed UPSERT per HTTP attempt. Never refund: acceptance after a timeout is unknowable. */
export async function reserveModelCall(opts: { ownerId: string; scope: QuotaScope; model: string; day?: string; cap: number }) {
  const zone = quotaTimezone(), day = opts.day ?? quotaDay();
  if (!opts.ownerId || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("INVALID_QUOTA_IDENTITY");
  if (!Number.isSafeInteger(opts.cap) || opts.cap < 0) throw new Error("INVALID_QUOTA_CAP");
  try {
    const result = await db.execute(sql`
      INSERT INTO model_call_quotas(owner_id, scope, model, day, attempts, legacy_used)
      SELECT ${opts.ownerId}, ${opts.scope}, ${opts.model}, ${day}::date, 1, count(*)
      FROM token_logs WHERE ${legacyWhere(opts.ownerId, opts.scope, day, zone)} AND model = ${opts.model}
      HAVING count(*) < ${opts.cap}
      ON CONFLICT (owner_id, scope, model, day) DO UPDATE
      SET attempts = model_call_quotas.attempts + 1,
          legacy_used = greatest(model_call_quotas.legacy_used, excluded.legacy_used)
      WHERE model_call_quotas.attempts + greatest(model_call_quotas.legacy_used, excluded.legacy_used) < ${opts.cap}
      RETURNING attempts`);
    return result.rows.length === 1;
  } catch { throw new QuotaAdmissionError("QUOTA_UNAVAILABLE"); }
}

export function quotaAdmission(cfg: BudgetConfig, scope: QuotaScope = "generation") {
  return async (model: string) => {
    // Synthetic/operator callers use the transport directly; application callers always supply config ownership.
    if (!cfg.ownerId) throw new Error("QUOTA_OWNER_REQUIRED");
    return reserveModelCall({ ownerId: cfg.ownerId, scope, model, cap: cfg.enforceLimits === false ? Number.MAX_SAFE_INTEGER : quotaCap(cfg, scope, model) });
  };
}

/** Authoritative reserved attempts plus legacy carry, independent of best-effort telemetry. */
export async function quotaUsage(ownerId: string, scope: QuotaScope = "generation", day = quotaDay()): Promise<Record<string, number>> {
  const result = await db.execute(sql`
    WITH legacy AS (SELECT model, count(*) AS used FROM token_logs
      WHERE ${legacyWhere(ownerId, scope, day, quotaTimezone())} AND model LIKE 'gemini-%' GROUP BY model),
    reserved AS (SELECT model, attempts, legacy_used FROM model_call_quotas WHERE owner_id=${ownerId} AND scope=${scope} AND day=${day}::date)
    SELECT coalesce(r.model,l.model) AS model, coalesce(r.attempts,0) + greatest(coalesce(r.legacy_used,0),coalesce(l.used,0)) AS used
    FROM reserved r FULL JOIN legacy l ON r.model=l.model`);
  return Object.fromEntries(result.rows.map(r => [String(r.model), Number(r.used)]));
}
