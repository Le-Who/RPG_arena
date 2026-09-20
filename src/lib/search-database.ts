import type { Pool, PoolClient, QueryResultRow } from "pg";

/** Bound both pool acquisition and SQL; SET LOCAL cannot leak through a pooled session. */
export async function runSearchQuery<T extends QueryResultRow>(pool: Pool, query: { text: string; values: unknown[] }, deadline: number): Promise<T[]> {
  const remaining = () => {
    const ms = Math.floor(deadline - Date.now());
    if (ms <= 0) throw new Error("MEMORY_SEARCH_TIMEOUT");
    return ms;
  };
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = remaining();
  let client: PoolClient;
  try {
    client = await Promise.race([
      pool.connect().then(connection => { if (expired) connection.release(); return connection; }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error("MEMORY_SEARCH_TIMEOUT")); }, timeout); }),
    ]);
  } finally { clearTimeout(timer); }
  let destroy = false;
  try {
    const ms = remaining();
    // pg supports per-query query_timeout; @types/pg only declares it on ClientConfig.
    const begin = { text: `BEGIN; SET LOCAL statement_timeout = '${ms}ms'`, query_timeout: ms };
    const search = { ...query, query_timeout: remaining() };
    await client.query(begin);
    search.query_timeout = remaining();
    const result = await client.query<T>(search);
    const commit = { text: "COMMIT", query_timeout: remaining() };
    await client.query(commit);
    return result.rows;
  } catch (error) {
    // Closing also cancels a query still running after the client-side deadline.
    destroy = true;
    throw error;
  } finally { client.release(destroy); }
}
