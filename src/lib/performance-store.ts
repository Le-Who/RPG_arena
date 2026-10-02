import { pool } from "@/db";
import { buildTurnReport, buildVitalsReport, type VitalSample } from "./performance-report";

export const PERFORMANCE_RETENTION_DAYS = 14;
const MAX_ROWS = 20_000;
const REPORT_SAMPLE_LIMIT = 20_000;
const REPORT_TURN_LIMIT = 500;
const TURN_WINDOW_DAYS = 30;
const SAMPLES_PER_MINUTE = 600;
const TELEMETRY_LOCK = 271018;
export const telemetryEnabled = () => process.env.CHRONICLE_TELEMETRY_ENABLED === "1";

/** Per-instance admission supplements the database-wide cap; telemetry is best-effort. */
const bucket = { tokens: SAMPLES_PER_MINUTE, updatedAt: Date.now() };
let recording = false;
export function admitSamples(requested: number, now = Date.now()): number {
  bucket.tokens = Math.min(SAMPLES_PER_MINUTE, bucket.tokens + (Math.max(0, now - bucket.updatedAt) / 60_000) * SAMPLES_PER_MINUTE);
  bucket.updatedAt = Math.max(now, bucket.updatedAt);
  const admitted = Number.isFinite(requested) ? Math.max(0, Math.min(Math.floor(requested), Math.floor(bucket.tokens))) : 0;
  bucket.tokens -= admitted;
  return admitted;
}

export async function recordVitalSamples(samples: VitalSample[]): Promise<number> {
  if (!telemetryEnabled() || recording || pool.waitingCount > 0 || (pool.idleCount === 0 && pool.totalCount >= (pool.options.max ?? 10))) return 0;
  let admitted = samples.slice(0, admitSamples(samples.length));
  if (!admitted.length) return 0;
  recording = true;
  const client = await pool.connect().catch(error => { recording = false; throw error; });
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '1000ms'");
    // Drop optional telemetry rather than queue behind another instance's ingestion.
    const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS locked", [TELEMETRY_LOCK]);
    if (!lock.rows[0]?.locked) { await client.query("ROLLBACK"); return 0; }
    const recent = await client.query<{ count: string }>("SELECT count(*) FROM performance_samples WHERE created_at >= now() - interval '1 minute'");
    admitted = admitted.slice(0, Math.max(0, SAMPLES_PER_MINUTE - Number(recent.rows[0]?.count ?? 0)));
    await client.query("DELETE FROM performance_samples WHERE created_at < now() - make_interval(days => $1::integer)", [PERFORMANCE_RETENTION_DAYS]);
    if (admitted.length) await client.query(
      `INSERT INTO performance_samples (metric, route, value, rating, device, navigation_type)
       SELECT * FROM unnest($1::text[], $2::text[], $3::float8[], $4::text[], $5::text[], $6::text[])`,
      [admitted.map((s) => s.metric), admitted.map((s) => s.route), admitted.map((s) => s.value), admitted.map((s) => s.rating), admitted.map((s) => s.device), admitted.map((s) => s.navigationType)],
    );
    await client.query("DELETE FROM performance_samples WHERE id <= (SELECT id FROM performance_samples ORDER BY id DESC OFFSET $1 LIMIT 1)", [MAX_ROWS]);
    await client.query("COMMIT");
    return admitted.length;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); recording = false; }
}

/** Administrative aggregate. Rows carry numbers, route templates and model names — never prose or owners. */
export async function loadPerformanceReport(days = 7) {
  const windowDays = Math.max(1, Math.min(PERFORMANCE_RETENTION_DAYS, Math.round(Number.isFinite(days) ? days : 7)));
  const [samples, turns] = await Promise.all([
    pool.query<{ metric: string; route: string; device: string; value: number }>(
      "SELECT metric, route, device, value FROM performance_samples WHERE created_at > now() - make_interval(days => $1::integer) ORDER BY id DESC LIMIT $2",
      [windowDays, REPORT_SAMPLE_LIMIT],
    ),
    pool.query<{ timings: unknown; budget: unknown; model: string | null }>(
      `SELECT context_meta->'timings' AS timings, context_meta->'promptBudget' AS budget, context_meta->>'model' AS model
       FROM game_turns WHERE role = 'narrator' AND context_meta IS NOT NULL AND created_at > now() - make_interval(days => $1::integer)
       ORDER BY created_at DESC LIMIT $2`,
      [TURN_WINDOW_DAYS, REPORT_TURN_LIMIT],
    ),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    retentionDays: PERFORMANCE_RETENTION_DAYS,
    turnWindowDays: TURN_WINDOW_DAYS,
    telemetryEnabled: telemetryEnabled(),
    sampleLimit: REPORT_SAMPLE_LIMIT,
    turnLimit: REPORT_TURN_LIMIT,
    vitals: buildVitalsReport(samples.rows),
    turns: buildTurnReport(turns.rows),
  };
}
export type PerformanceReport = Awaited<ReturnType<typeof loadPerformanceReport>>;
