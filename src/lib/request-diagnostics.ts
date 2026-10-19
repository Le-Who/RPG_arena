import { AsyncLocalStorage } from "node:async_hooks";
import { formatDatabaseTiming, withDatabaseTiming } from "@/db/pool";

type Phase = "identity" | "admission" | "handler" | "cleanup";
type Diagnostics = { first: boolean; phases: Partial<Record<Phase, number>> };
const globals = globalThis as typeof globalThis & {
  __chronicleRequestDiagnostics?: { scope: AsyncLocalStorage<Diagnostics>; seen: boolean };
};
const diagnostics = globals.__chronicleRequestDiagnostics ??= { scope: new AsyncLocalStorage<Diagnostics>(), seen: false };

/** Never publish a database hostname, URL, account, profile or deployment ID. */
export function databaseLocation(connectionString: string | undefined) {
  try {
    const hostname = new URL(connectionString ?? "").hostname;
    const neon = hostname.match(/^[a-z0-9-]+\.(?:c-\d+\.)?([a-z]{2}-[a-z]+-\d)\.(aws|azure)\.neon\.tech$/);
    return neon ? { region: `${neon[2]}-${neon[1]}`, mode: hostname.split(".")[0].endsWith("-pooler") ? "pooled" : "direct" } : { region: "unknown", mode: "unknown" };
  } catch { return { region: "unknown", mode: "unknown" }; }
}

export async function measureRequestPhase<T>(name: Phase, run: () => Promise<T>): Promise<T> {
  const current = diagnostics.scope.getStore();
  if (!current) return run();
  const started = performance.now();
  try { return await run(); }
  finally { current.phases[name] = (current.phases[name] ?? 0) + Math.max(0, performance.now() - started); }
}

/** First instrumented attempt in this JS context, not a measurement of platform cold
 * start. Pool totals can overlap for parallel queries; phase durations are wall time.
 * Catch handler errors inside run so cleanup/error responses retain diagnostics. */
export async function withRequestDiagnostics(run: () => Promise<Response>): Promise<Response> {
  const current: Diagnostics = { first: !diagnostics.seen, phases: {} };
  diagnostics.seen = true;
  const { value: response, timing } = await withDatabaseTiming(() => diagnostics.scope.run(current, run));
  try {
    const database = formatDatabaseTiming(timing);
    const phases = Object.entries(current.phases).map(([name, ms]) => `${name};dur=${ms.toFixed(1)}`);
    response.headers.append("Server-Timing", [database.serverTiming, ...phases].join(", "));
    response.headers.set("X-Chronicle-Pool", database.pool);
    response.headers.set("X-Chronicle-Instance-First", current.first ? "1" : "0");
    response.headers.set("X-Chronicle-Region", /^[a-z]{3}\d$/.test(process.env.VERCEL_REGION ?? "") ? process.env.VERCEL_REGION! : "local");
    const location = databaseLocation(process.env.DATABASE_URL);
    response.headers.set("X-Chronicle-Database-Region", location.region);
    response.headers.set("X-Chronicle-Database-Mode", location.mode);
    response.headers.set("X-Chronicle-Auto-Migrate", process.env.CHRONICLE_AUTO_MIGRATE === "1" ? "1" : "0");
  } catch { /* Optional diagnostics must not change immutable responses. */ }
  return response;
}
