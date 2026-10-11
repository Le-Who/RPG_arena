import "./test-environment";
import { Pool, type QueryConfig, type PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { AsyncLocalStorage } from "node:async_hooks";

Object.assign(globalThis, { AsyncLocalStorage });
for (const name of Object.keys(process.env)) if (name.startsWith("PG")) delete process.env[name];

export function visualBarrier() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return { entered, release, async hold() { enter(); await released; } };
}

export async function boundedVisual<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 8000);
    })]);
  } finally { clearTimeout(timer); }
}

type Hook = (sql: string, phase: "before" | "after") => Promise<void>;
type ImageRoute = {
  GET(request: Request, context: { params: Promise<{ id: string; visualId: string }> }): Promise<Response>;
  DELETE(request: Request, context: { params: Promise<{ id: string; visualId: string }> }): Promise<Response>;
};

export async function visualPostgresFixture() {
  const schema = `visual_${randomUUID().replaceAll("-", "")}`;
  const url = new URL("postgresql://chronicle_test:fixture-only@127.0.0.1:55439/chronicle_auth_test");
  const bootstrap = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  const pools: Pool[] = [];
  const bindings: string[] = [];
  const output = resolve("output/p1-continuation/visual");
  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(join(output, "native-"));
  const globals = globalThis as unknown as Record<string, unknown>;
  let created = false;
  async function close() {
    try {
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
    const control = new Pool({ connectionString: url.toString() });
    pools.push(control);
    // Native relational fixture only: 0006 is immutable and intentionally not
    // replayed on this server without pgvector. PGlite owns full migration replay.
    for (const file of (await readdir("drizzle")).filter(x => /^\d{4}_.*\.sql$/.test(x) && !x.startsWith("0006_")).sort())
      await control.query((await readFile(`drizzle/${file}`, "utf8")).replaceAll('"public".', `"${schema}".`));
    async function imageRoute(hook: Hook = async () => {}) {
      const pool = new Pool({ connectionString: url.toString(), max: 4 });
      pools.push(pool);
      const wrap = (source: Pool | PoolClient) => ({ async query(query: string | QueryConfig, values?: unknown[]) {
        const sql = typeof query === "string" ? query : query.text;
        await hook(sql, "before");
        const result = await source.query(query, values);
        await hook(sql, "after");
        return result;
      } });
      const transport = { ...wrap(pool), async connect() {
        const client = await pool.connect();
        return { ...wrap(client), release: () => client.release() };
      } };
      const key = `chronicle-visual-${randomUUID()}`;
      bindings.push(key);
      globals[key] = { pool: transport, db: drizzle(transport as never) };
      // Separate bundles have separate production inflight maps, auth and work
      // scopes; all SQL reaches independent real native PostgreSQL connections.
      const bundled = await build({
        entryPoints: [resolve("src/app/api/sessions/[id]/visuals/[visualId]/route.ts")],
        bundle: true, platform: "node", format: "esm", packages: "external",
        write: false, logLevel: "silent",
        plugins: [{ name: "owned-native-visual-db", setup(builder) {
          builder.onResolve({ filter: /^@\/db$/ }, () => ({ path: key, namespace: "fixture-db" }));
          builder.onLoad({ filter: /.*/, namespace: "fixture-db" }, () => ({
            contents: `export const {pool,db} = globalThis[${JSON.stringify(key)}];`, loader: "js",
          }));
        } }],
      });
      const path = join(temporary, `${key}.mjs`);
      await writeFile(path, bundled.outputFiles[0].contents);
      return { route: await import(pathToFileURL(path).href) as ImageRoute, pool };
    }
    return { control, imageRoute, schema, close };
  } catch (error) { await close(); throw error; }
}
