import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";
import { createDatabasePool } from "./pool";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  createDatabasePool({
    connectionString: databaseUrl,
  });

// pg removes its idle error listener while a client is borrowed. Keep a listener
// through that gap: query promises still reject and pg still discards broken clients.
// Symbols also survive development module reloads of the globally reused pool.
const poolErrors = Symbol.for("chronicle.postgres.pool-errors");
const clientErrors = Symbol.for("chronicle.postgres.client-errors");
const guardedPool = pool as Pool & { [poolErrors]?: boolean };
function guardClient(client: PoolClient) {
  const guarded = client as PoolClient & { [clientErrors]?: boolean };
  if (guarded[clientErrors]) return;
  guarded[clientErrors] = true;
  client.on("error", () => { console.warn("postgres_client_connection_error"); });
}
if (!guardedPool[poolErrors]) {
  guardedPool[poolErrors] = true;
  // Emit only fixed categories; errors can contain SQL, connection data and secrets.
  pool.on("error", () => { console.warn("postgres_pool_connection_error"); });
  pool.on("connect", guardClient);
  pool.on("acquire", guardClient);
}

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

export const db = drizzle(pool);
