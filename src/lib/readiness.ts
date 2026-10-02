import { getTableName, is, Table } from "drizzle-orm";
import * as schema from "../db/schema";
import journal from "../../drizzle/meta/_journal.json";

type Query = (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
export type Readiness = { ok: boolean; database: boolean; schema: boolean; memorySearch: boolean };
const requiredTables = Object.values(schema).filter(value => is(value, Table)).map(value => getTableName(value as Table));

/** Schema presence, shipped ledger version and callable search capabilities; no secret/profile data. */
export async function checkReadiness(query: Query): Promise<Readiness> {
  const state: Readiness = { ok: false, database: false, schema: false, memorySearch: false };
  try {
    const result = await query(`SELECT
      NOT EXISTS (SELECT 1 FROM unnest($1::text[]) AS required(name)
        WHERE to_regclass('public.' || quote_ident(required.name)) IS NULL) AS base_present,
      to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS ledger_present,
      (EXISTS (SELECT 1 FROM pg_extension WHERE extname='vector')
       AND to_regprocedure('public.chronicle_memory_vector(real[],integer)') IS NOT NULL
       AND to_regprocedure('public.chronicle_embedding_hash(text,integer,text,text)') IS NOT NULL) AS search_present`, [requiredTables]);
    const row = result.rows[0];
    state.database = true;
    if (row?.base_present === true && row.ledger_present === true) {
      const latest = journal.entries.at(-1)?.when;
      if (latest !== undefined) {
        const ledger = await query("SELECT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at=$1) AS current", [latest]);
        state.schema = ledger.rows[0]?.current === true;
      }
    }
    if (row?.search_present === true) {
      const capabilities = await query(`SELECT
        public.chronicle_memory_vector(ARRAY[1,0]::real[],2) IS NOT NULL
        AND public.chronicle_embedding_hash('readiness',2,'probe','probe') ~ '^[0-9a-f]{32}$' AS working`);
      state.memorySearch = capabilities.rows[0]?.working === true;
    }
    state.ok = state.schema && state.memorySearch;
  } catch {
    // Readiness stays false; driver errors/connection details are not part of the public contract.
  }
  return state;
}

export function readinessResponse(state: Readiness): Response {
  return Response.json({ ok: state.ok }, { status: state.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
