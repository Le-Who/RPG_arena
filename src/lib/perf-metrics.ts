// PERF-4: клиентские измерения без отправки данных на сервер.
// Resource Timing + Server-Timing этой вкладки → p50/p95 по нормализованным API-маршрутам.

export type ApiTimingEntry = { name: string; duration: number; serverTiming?: readonly { name: string; duration: number }[]; transferSize?: number };
export type ApiRouteSummary = { route: string; count: number; p50: number; p95: number; serverP50: number | null; serverP95: number | null; bytes: number };

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Nearest-rank percentile on a copy; empty input → 0. */
export function percentile(values: readonly number[], p: number): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((Math.min(100, Math.max(0, p)) / 100) * sorted.length)));
  return sorted[rank - 1];
}

/** `/api/sessions/<uuid>/turns?before=3` → `/api/sessions/:id/turns`. Non-API URLs → null. */
export function normalizeApiRoute(url: string, origin = "http://localhost"): string | null {
  let pathname: string;
  try { pathname = new URL(url, origin).pathname; } catch { return null; }
  if (!pathname.startsWith("/api/")) return null;
  return pathname.replace(UUID, ":id").replace(/\/\d+(?=\/|$)/g, "/:n");
}

export function summarizeApiTimings(entries: readonly ApiTimingEntry[], origin?: string): ApiRouteSummary[] {
  const groups = new Map<string, { durations: number[]; server: number[]; bytes: number }>();
  for (const entry of entries) {
    const route = normalizeApiRoute(entry.name, origin);
    if (!route) continue;
    const group = groups.get(route) ?? { durations: [], server: [], bytes: 0 };
    group.durations.push(entry.duration);
    const app = entry.serverTiming?.find(timing => timing.name === "app");
    if (app) group.server.push(app.duration);
    group.bytes += entry.transferSize ?? 0;
    groups.set(route, group);
  }
  return [...groups.entries()].map(([route, group]) => ({
    route, count: group.durations.length,
    p50: round(percentile(group.durations, 50)), p95: round(percentile(group.durations, 95)),
    serverP50: group.server.length ? round(percentile(group.server, 50)) : null,
    serverP95: group.server.length ? round(percentile(group.server, 95)) : null,
    bytes: group.bytes,
  })).sort((a, b) => b.p95 - a.p95 || a.route.localeCompare(b.route));
}

/** Web Vitals thresholds (good / needs improvement) as published by web.dev. */
export const VITAL_BUDGETS = { lcp: [2500, 4000], cls: [0.1, 0.25], inp: [200, 500], ttfb: [800, 1800] } as const;
export type VitalName = keyof typeof VITAL_BUDGETS;
export function rateVital(name: VitalName, value: number | null): "good" | "needs-improvement" | "poor" | "unknown" {
  if (value === null || !Number.isFinite(value)) return "unknown";
  const [good, poor] = VITAL_BUDGETS[name];
  return value <= good ? "good" : value <= poor ? "needs-improvement" : "poor";
}

const round = (value: number) => Math.round(value * 10) / 10;
