import { PROMPT_BUDGET_SECTIONS, PROMPT_SECTION_LABELS, readPromptBudget } from "./prompt-budget";

/** PERF-1 / PERF-2 / PERF-4 / NARR-12: pure validation and aggregation of anonymous measurements.
 * Dependency-light on purpose: the browser reporter imports the metric maps from this module. */
export type VitalMetric = "LCP" | "INP" | "CLS" | "FCP" | "TTFB";
export type ClientTiming = "API_AUTH" | "API_SESSIONS" | "API_SETTINGS" | "API_WORKSPACE" | "TURN_FIRST_TEXT" | "TURN_COMMITTED" | "TURN_PAINT";
export type SampleMetric = VitalMetric | ClientTiming;
export type Rating = "good" | "needs-improvement" | "poor" | "unknown";
export type Device = "mobile" | "desktop" | "unknown";
export type VitalSample = { metric: SampleMetric; route: string; value: number; rating: Rating; device: Device; navigationType: string };
export type Summary = { count: number; p50: number; p75: number; p95: number; max: number };

// web.dev thresholds; field data is judged at the 75th percentile.
export const VITAL_THRESHOLDS: Record<VitalMetric, { good: number; poor: number; unit: "ms" | ""; label: string }> = {
  LCP: { good: 2500, poor: 4000, unit: "ms", label: "Отрисовка главного содержимого" },
  INP: { good: 200, poor: 500, unit: "ms", label: "Отклик на действия" },
  CLS: { good: 0.1, poor: 0.25, unit: "", label: "Сдвиги макета" },
  FCP: { good: 1800, poor: 3000, unit: "ms", label: "Первый контент" },
  TTFB: { good: 800, poor: 1800, unit: "ms", label: "Первый байт документа" },
};
export const VITAL_METRICS = Object.keys(VITAL_THRESHOLDS) as VitalMetric[];
export const CLIENT_TIMING_LABELS: Record<ClientTiming, string> = {
  API_AUTH: "Первый экран · /api/auth/me",
  API_SESSIONS: "Первый экран · /api/sessions",
  API_SETTINGS: "Первый экран · /api/settings",
  API_WORKSPACE: "Первый экран · /api/workspace",
  TURN_FIRST_TEXT: "Ход · первый текст в браузере",
  TURN_COMMITTED: "Ход · подтверждённое сохранение",
  TURN_PAINT: "Ход · отрисовка результата",
};
export const CLIENT_TIMINGS = Object.keys(CLIENT_TIMING_LABELS) as ClientTiming[];
/** Same-origin resource paths of the first screen (see AppShell.refresh). */
export const API_RESOURCE_METRICS: Record<string, ClientTiming> = { "/api/auth/me": "API_AUTH", "/api/sessions": "API_SESSIONS", "/api/settings": "API_SETTINGS", "/api/workspace": "API_WORKSPACE" };
/** performance.measure names emitted by use-turn-request. */
export const TURN_MEASURE_METRICS: Record<string, ClientTiming> = { "chronicle:turn:first-text": "TURN_FIRST_TEXT", "chronicle:turn:committed": "TURN_COMMITTED", "chronicle:turn:paint": "TURN_PAINT" };

const KNOWN_ROUTES = new Set(["/", "/campaigns", "/worlds", "/characters", "/memory", "/journal", "/settings", "/system", "/system/visuals", "/blueprint", "/design"]);
const NAVIGATION_TYPES = new Set(["navigate", "reload", "back-forward", "back-forward-cache", "prerender", "restore"]);
const DEVICES = new Set<Device>(["mobile", "desktop"]);
const MAX_VALUE = 600_000;
export const MAX_BATCH = 20;

/** Only known route templates are stored; campaign IDs and unknown paths never reach the database. */
export function routeTemplate(pathname: unknown): string {
  if (typeof pathname !== "string" || !pathname.startsWith("/") || pathname.length > 300) return "other";
  const path = pathname.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  if (KNOWN_ROUTES.has(path)) return path;
  if (/^\/play\/[^/]+$/.test(path)) return "/play/[id]";
  return "other";
}

export function isSampleMetric(value: unknown): value is SampleMetric {
  return typeof value === "string" && (Object.hasOwn(VITAL_THRESHOLDS, value) || Object.hasOwn(CLIENT_TIMING_LABELS, value));
}

export function rateSample(metric: SampleMetric, value: number): Rating {
  const threshold = (VITAL_THRESHOLDS as Partial<Record<SampleMetric, { good: number; poor: number }>>)[metric];
  if (!threshold) return "unknown";
  return value <= threshold.good ? "good" : value <= threshold.poor ? "needs-improvement" : "poor";
}

/** The server recomputes ratings and route templates; client labels are never trusted. */
export function parseVitalBatch(raw: unknown): { samples: VitalSample[]; rejected: number } {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { samples?: unknown }).samples) ? (raw as { samples: unknown[] }).samples : [];
  const samples: VitalSample[] = [];
  let rejected = Math.max(0, list.length - MAX_BATCH);
  for (const item of list.slice(0, MAX_BATCH)) {
    const entry = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null;
    const metric = entry?.metric;
    const value = entry?.value;
    if (!entry || !isSampleMetric(metric) || typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > (metric === "CLS" ? 100 : MAX_VALUE)) { rejected++; continue; }
    const device = DEVICES.has(entry.device as Device) ? entry.device as Device : "unknown";
    const navigationType = typeof entry.navigationType === "string" && NAVIGATION_TYPES.has(entry.navigationType) ? entry.navigationType : "";
    samples.push({ metric, route: routeTemplate(entry.route), value: Math.round(value * 1000) / 1000, rating: rateSample(metric, value), device, navigationType });
  }
  return { samples, rejected };
}

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (Math.max(0, Math.min(100, p)) / 100) * (sorted.length - 1);
  const low = Math.floor(rank), high = Math.ceil(rank);
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

export function summarize(values: number[]): Summary {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return { count: sorted.length, p50: round(percentile(sorted, 50)), p75: round(percentile(sorted, 75)), p95: round(percentile(sorted, 95)), max: round(sorted.at(-1) ?? 0) };
}

type SampleRow = { metric: string; route: string; device: string; value: number | string };
const numeric = (value: unknown): number | null => {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

export function buildVitalsReport(rows: SampleRow[]) {
  const byMetric = new Map<string, SampleRow[]>();
  for (const row of rows) if (isSampleMetric(row.metric) && numeric(row.value) !== null) {
    const group = byMetric.get(row.metric) ?? [];
    group.push(row);
    byMetric.set(row.metric, group);
  }
  const values = (list: SampleRow[]) => list.map((row) => numeric(row.value)!).filter((value) => value !== null);
  const vitals = VITAL_METRICS.map((metric) => {
    const list = byMetric.get(metric) ?? [];
    const summary = summarize(values(list));
    const routes = new Map<string, SampleRow[]>();
    for (const row of list) {
      const group = routes.get(row.route) ?? [];
      group.push(row);
      routes.set(row.route, group);
    }
    return {
      metric, label: VITAL_THRESHOLDS[metric].label, unit: VITAL_THRESHOLDS[metric].unit,
      thresholds: { good: VITAL_THRESHOLDS[metric].good, poor: VITAL_THRESHOLDS[metric].poor },
      summary, rating: summary.count ? rateSample(metric, summary.p75) : "unknown" as Rating,
      devices: { mobile: summarize(values(list.filter((row) => row.device === "mobile"))), desktop: summarize(values(list.filter((row) => row.device === "desktop"))) },
      routes: [...routes.entries()].map(([route, items]) => ({ route, count: items.length, p75: summarize(values(items)).p75 })).sort((a, b) => b.count - a.count || a.route.localeCompare(b.route)).slice(0, 6),
    };
  });
  const timings = CLIENT_TIMINGS.map((metric) => ({ metric, label: CLIENT_TIMING_LABELS[metric], summary: summarize(values(byMetric.get(metric) ?? [])) }));
  return { totalSamples: rows.length, vitals, timings };
}

export const TURN_STAGES = [
  ["admissionMs", "Допуск хода"], ["contextMs", "Сбор контекста"], ["retrievalMs", "Поиск памяти"],
  ["generationMs", "Генерация рассказа"], ["firstTextMs", "Первый текст (сервер)"], ["verificationMs", "Проверка рассказа"],
  ["validationMs", "Проверка последствий"], ["writesMs", "Запись в БД"], ["serverMs", "Весь ход на сервере"],
] as const;

type TurnRow = { timings: unknown; budget: unknown; model: unknown };
const field = (source: unknown, key: string) => (source && typeof source === "object" && !Array.isArray(source) ? numeric((source as Record<string, unknown>)[key]) : null);

export function buildTurnReport(rows: TurnRow[]) {
  const withTimings = rows.filter((row) => TURN_STAGES.some(([key]) => field(row.timings, key) !== null));
  const stages = TURN_STAGES.map(([key, label]) => ({ key, label, summary: summarize(withTimings.map((row) => field(row.timings, key)).filter((value): value is number => value !== null)) }));
  const budgets = rows.map((row) => readPromptBudget(row.budget)).filter((budget) => budget !== null);
  const sections = PROMPT_BUDGET_SECTIONS.map((key) => {
    const summary = summarize(budgets.map((budget) => budget.sections[key] ?? 0));
    const shares = budgets.filter(budget => budget.systemChars + budget.userChars > 0)
      .map(budget => 100 * (budget.sections[key] ?? 0) / (budget.systemChars + budget.userChars));
    return { key, label: PROMPT_SECTION_LABELS[key], summary, share: Math.round(summarize(shares).p50 * 10) / 10 };
  }).filter((section) => section.summary.max > 0).sort((a, b) => b.summary.p50 - a.summary.p50);
  const models = new Map<string, number>();
  for (const row of rows) if (typeof row.model === "string" && row.model) models.set(row.model.slice(0, 120), (models.get(row.model.slice(0, 120)) ?? 0) + 1);
  return {
    turns: rows.length,
    timedTurns: withTimings.length,
    stages,
    attempts: summarize(withTimings.map((row) => field(row.timings, "attempts")).filter((value): value is number => value !== null)),
    prompt: {
      measuredTurns: budgets.length,
      systemChars: summarize(budgets.map((budget) => budget.systemChars)),
      userChars: summarize(budgets.map((budget) => budget.userChars)),
      schemaChars: summarize(budgets.map((budget) => budget.schemaChars)),
      estimatedTokens: summarize(budgets.map((budget) => budget.estimatedTokens)),
      sections,
    },
    models: [...models.entries()].map(([model, count]) => ({ model, count })).sort((a, b) => b.count - a.count).slice(0, 8),
  };
}
