import { mock } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFile, readdir } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";

Object.assign(globalThis, { AsyncLocalStorage });

export async function accountsDb() {
  const { pool } = await import("../../src/db");
  const pg = new PGlite({ extensions: { vector, pgcrypto } });
  await pg.exec("SET TIME ZONE 'UTC'");
  for (const file of (await readdir("drizzle")).filter(x => /^\d{4}_.*\.sql$/.test(x)).sort()) await pg.exec(await readFile(`drizzle/${file}`, "utf8"));
  const run = async (query: string | { text: string; values?: unknown[]; rowMode?: string }, values?: unknown[]) => {
    const config = typeof query === "string" ? { text: query, values } : { ...query, values: values ?? query.values };
    if (config.text.startsWith("BEGIN;")) { await pg.exec(config.text); return { rows: [] }; }
    const result = await pg.query<Record<string, unknown>>(config.text, config.values);
    const normalize = (v: unknown) => v instanceof Date ? v.toISOString() : v;
    return { ...result, rows: result.rows.map(row => config.rowMode === "array" ? result.fields.map(f => normalize(row[f.name])) : Object.fromEntries(Object.entries(row).map(([k, v]) => [k, normalize(v)]))) };
  };
  let tail = Promise.resolve();
  const queryMock = mock.method(pool, "query", run as never);
  const connectMock = mock.method(pool, "connect", async () => {
    const before = tail;
    let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    await before;
    return { query: run, release };
  });
  return { pg, run, async close() { queryMock.mock.restore(); connectMock.mock.restore(); await pg.close(); } };
}

export async function cookieContext<T>(cookie: string, fn: () => Promise<T>, afterJobs: (() => Promise<void>)[] = []) {
  // Real Next request storage, not a mocked authorization helper.
  const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external");
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external");
  const { RequestCookies } = await import("next/dist/server/web/spec-extension/cookies");
  return workAsyncStorage.run({ route: "/test", isStaticGeneration: false, afterContext: { after: (job: () => Promise<void>) => { afterJobs.push(job); } } } as never, () => workUnitAsyncStorage.run({ type: "request", phase: "render", cookies: new RequestCookies(new Headers({ cookie })) } as never, fn));
}
