import "./test-environment";
import { Pool, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { VitalSample } from "../../src/lib/performance-report";

// This fixture cannot inherit PG service files, passwords, hosts or a user's DB.
for (const name of Object.keys(process.env)) if (name.startsWith("PG")) delete process.env[name];

export type TelemetryHook = (sql: string, phase: "before" | "after", pid: number) => Promise<void>;
type Reporter = { recordVitalSamples(samples: VitalSample[]): Promise<number> };

export function telemetryBarrier() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return { entered, release, async hold() { enter(); await released; } };
}

export async function boundedTelemetry<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 8000);
    })]);
  } finally { clearTimeout(timer); }
}

export async function performancePostgresFixture() {
  const schema = `performance_${randomUUID().replaceAll("-", "")}`;
  const url = new URL("postgresql://chronicle_test:fixture-only@127.0.0.1:55439/chronicle_auth_test");
  const bootstrap = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  const pools: Pool[] = [];
  const leased = new Set<PoolClient>();
  const bindings: string[] = [];
  const temporary = await mkdtemp(join(tmpdir(), "chronicle-performance-"));
  const globals = globalThis as unknown as Record<string, unknown>;
  let created = false;
  async function close() {
    try {
      // A missing production release must fail assertions without hanging cleanup.
      for (const client of leased) client.release(true);
      leased.clear();
      await Promise.all(pools.map(pool => pool.end()));
      if (created) await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await bootstrap.end();
      for (const key of bindings) delete globals[key];
      await rm(temporary, { recursive: true, force: true });
    }
  }
  try {
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    url.searchParams.set("options", `-csearch_path=${schema},public -cstatement_timeout=10000 -clock_timeout=8000`);
    const control = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
    pools.push(control);
    // Minimal native fixture: immutable 0018 only. No campaign/auth relations,
    // no migration ledger, no 0006/pgvector rewrite and no 19/20 replay claim.
    await control.query(await readFile("drizzle/0018_performance_samples.sql", "utf8"));
    async function reporter(hook: TelemetryHook = async () => {}) {
      const pool = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 5000 });
      pools.push(pool);
      const key = `chronicle-performance-${randomUUID()}`;
      bindings.push(key);
      globals[key] = {
        get waitingCount() { return pool.waitingCount; },
        get idleCount() { return pool.idleCount; },
        get totalCount() { return pool.totalCount; },
        options: pool.options,
        async connect() {
          const client = await pool.connect();
          leased.add(client);
          try {
            const pid: number = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
            return {
              async query(sql: string, values?: unknown[]) {
                await hook(sql, "before", pid);
                const result = await client.query(sql, values);
                await hook(sql, "after", pid);
                return result;
              },
              release() { leased.delete(client); client.release(); },
            };
          } catch (error) { leased.delete(client); client.release(); throw error; }
        },
      };
      // Two bundles have separate actual module-local buckets/recording flags.
      // Only @/db wiring changes; every production SQL query reaches native PG.
      const bundled = await build({
        entryPoints: [resolve("src/lib/performance-store.ts")], bundle: true,
        platform: "node", format: "esm", write: false, logLevel: "silent",
        plugins: [{ name: "owned-native-performance-pool", setup(builder) {
          builder.onResolve({ filter: /^@\/db$/ }, () => ({ path: key, namespace: "fixture-pool" }));
          builder.onLoad({ filter: /.*/, namespace: "fixture-pool" }, () => ({
            contents: `export const pool = globalThis[${JSON.stringify(key)}];`, loader: "js",
          }));
        } }],
      });
      const path = join(temporary, `${key}.mjs`);
      await writeFile(path, bundled.outputFiles[0].contents);
      const reporterModule = await import(pathToFileURL(path).href) as Reporter;
      return { module: reporterModule, pool };
    }
    return { control, reporter, schema, close };
  } catch (error) { await close(); throw error; }
}
