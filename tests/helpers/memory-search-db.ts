import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { formatDocument } from "../../src/lib/vector";

export const sessionId = "00000000-0000-4000-8000-000000000001";
export const otherSessionId = "00000000-0000-4000-8000-000000000002";
export const model = "gemini-embedding-2";
export const embeddingHash = (title: string, content: string, dims: number) => createHash("sha1").update([model, String(dims), formatDocument(title, content)].join("\u241f")).digest("hex").slice(0, 32);

export async function memorySearchDb() {
  const pg = new PGlite({ extensions: { vector, pgcrypto } });
  await pg.exec(`
    CREATE TABLE memory_nodes (
      id uuid PRIMARY KEY, session_id uuid NOT NULL, layer text NOT NULL, category text DEFAULT 'event',
      title text NOT NULL, content text NOT NULL, importance real DEFAULT 50, salience real DEFAULT 50,
      source text DEFAULT 'state', source_turn integer, turn_to integer, evidence text
    );
    CREATE TABLE memory_embeddings (
      id uuid PRIMARY KEY, memory_node_id uuid NOT NULL, session_id uuid NOT NULL,
      model text NOT NULL, dims integer NOT NULL, status text NOT NULL,
      content_hash text NOT NULL, vector real[]
    );
  `);
  await pg.exec(await readFile(new URL("../../drizzle/0006_database_memory_search.sql", import.meta.url), "utf8"));
  return pg;
}

export function queryVector(dims: number) { return Array.from({ length: dims }, (_, i) => i === 0 ? 1 : 0); }
export function documentVector(dims: number, similarity: number) { return Array.from({ length: dims }, (_, i) => i === 0 ? similarity : i === 1 ? Math.sqrt(1 - similarity ** 2) : 0); }

export async function insertMemory(pg: PGlite, index: number, dims: number, options: {
  similarity?: number; importance?: number; salience?: number; layer?: string; source?: string; turnTo?: number;
  session?: string; embeddingSession?: string; embeddingModel?: string; status?: string; stale?: boolean;
  values?: number[] | null; title?: string; content?: string;
} = {}) {
  const id = `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const title = options.title ?? `Memory ${index}`, content = options.content ?? "A remembered event";
  const values = options.values === undefined ? documentVector(dims, options.similarity ?? .8) : options.values;
  await pg.query(`INSERT INTO memory_nodes (id, session_id, title, content, layer, importance, salience, source, turn_to)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, options.session ?? sessionId, title, content, options.layer ?? "semantic", options.importance ?? 50, options.salience ?? 50, options.source ?? "state", options.turnTo ?? 100]);
  await pg.query(`INSERT INTO memory_embeddings VALUES ($1,$1,$2,$3,$4,$5,$6,$7::real[])`,
    [id, options.embeddingSession ?? options.session ?? sessionId, options.embeddingModel ?? model, dims, options.status ?? "ready", options.stale ? "stale" : embeddingHash(title, content, dims), values]);
  return id;
}
