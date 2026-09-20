import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import { db, pool } from "@/db";
import { memoryEmbeddings, memoryNodes, tokenLogs } from "@/db/schema";
import { estimateTokens } from "./gemini";
import { hashContent } from "./memory";
import { EMBEDDING_MODEL, DEFAULT_EMBEDDING_DIMS, cosine, formatDocument, formatQuery, isValidVector } from "./vector";
import { queryVectorCache } from "./query-vectors";
import { sessionOwnerId } from "./campaign-access";
import { currentProfileId } from "./identity";
import { buildMemorySearchQuery, describeRetrievedNode, type DatabaseSearchResult, type RetrievedNode } from "./memory-search";
import { runSearchQuery } from "./search-database";
export type { RetrievedNode } from "./memory-search";
export { DEFAULT_EMBEDDING_DIMS, cosine, formatDocument, formatQuery };
export const EMBEDDING_MODEL_ALIASES = [EMBEDDING_MODEL];

/** One vector space, one total timeout, no silent migration to a preview model. */
export async function embedTexts(opts: { keys: string[]; model: string; dims: number; texts: string[]; sessionId?: string | null; timeoutMs?: number }): Promise<{ vectors: number[][]; model: string; latencyMs: number }> {
  if (opts.model !== EMBEDDING_MODEL) throw new Error("INCOMPATIBLE_EMBEDDING_MODEL: требуется gemini-embedding-2");
  if (!Number.isInteger(opts.dims) || opts.dims < 128 || opts.dims > 3072) throw new Error("INVALID_DIMENSIONS");
  if (!opts.keys.length) throw new Error("Для семантического поиска добавьте ключ Gemini в настройках.");
  if (!opts.texts.length) return { vectors: [], model: opts.model, latencyMs: 0 };
  if (opts.texts.length > 100 || opts.texts.some((s) => !s.trim() || s.length > 12000)) throw new Error("INVALID_EMBEDDING_INPUT");
  const started = Date.now();
  const budget = Math.min(opts.timeoutMs ?? 15000, 30000);
  let lastError = "Сервис эмбеддингов недоступен";
  for (let i = 0; i < Math.min(opts.keys.length, 3); i++) {
    const remaining = budget - (Date.now() - started);
    if (remaining < 250) break;
    const batch = opts.texts.length > 1;
    const request = (text: string) => ({ model: `models/${EMBEDDING_MODEL}`, content: { parts: [{ text }] }, outputDimensionality: opts.dims });
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:${batch ? "batchEmbedContents" : "embedContent"}`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": opts.keys[i] },
        signal: AbortSignal.timeout(remaining), body: JSON.stringify(batch ? { requests: opts.texts.map(request) } : request(opts.texts[0])),
      });
      if (!response.ok) {
        lastError = `Gemini: HTTP ${response.status}`;
        await logEmbeddingCall(opts, Date.now() - started, false, lastError, i);
        if ([400, 404].includes(response.status)) break;
        continue;
      }
      const data = await response.json();
      const vectors: unknown[] = batch ? (data.embeddings ?? []).map((e: { values: unknown }) => e.values) : [data.embedding?.values];
      if (vectors.length !== opts.texts.length || !vectors.every((v) => isValidVector(v, opts.dims))) throw new Error("INVALID_VECTOR_RESPONSE");
      await logEmbeddingCall(opts, Date.now() - started, true, "", i);
      return { vectors: vectors as number[][], model: EMBEDDING_MODEL, latencyMs: Date.now() - started };
    } catch (error) {
      lastError = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "Gemini не ответил вовремя" : "Некорректный ответ сервиса эмбеддингов";
      await logEmbeddingCall(opts, Date.now() - started, false, lastError, i);
    }
  }
  throw new Error(lastError);
}
async function logEmbeddingCall(opts: { sessionId?: string | null; texts: string[] }, latencyMs: number, success: boolean, error: string, keyIndex: number) {
  const promptTokens = opts.texts.reduce((sum, text) => sum + estimateTokens(text), 0);
  try { await db.insert(tokenLogs).values({ ownerId: opts.sessionId ? await sessionOwnerId(opts.sessionId) : await currentProfileId(), sessionId: opts.sessionId ?? null, model: EMBEDDING_MODEL, taskType: "embedding", promptTokens, completionTokens: 0, totalTokens: promptTokens, latencyMs, success, error, keyIndex }); } catch { /* telemetry must not break play */ }
}
export async function enqueueEmbeddings(sessionId: string, nodeIds: string[], model: string, dims: number) {
  if (!nodeIds.length) return;
  const nodes = await db.select().from(memoryNodes).where(and(eq(memoryNodes.sessionId, sessionId), inArray(memoryNodes.id, nodeIds)));
  for (const node of nodes) {
    const contentHash = hashContent(model, String(dims), formatDocument(node.title, node.content));
    const row = { model, dims, contentHash, status: "pending" as const, attempts: 0, error: "", vector: null, leaseToken: null, leaseExpiresAt: null, nextAttemptAt: new Date(), updatedAt: new Date() };
    await db.insert(memoryEmbeddings).values({ memoryNodeId: node.id, sessionId, ...row }).onConflictDoUpdate({ target: memoryEmbeddings.memoryNodeId, set: row, setWhere: sql`${memoryEmbeddings.contentHash} <> excluded.content_hash` });
  }
}
export async function backfillSession(sessionId: string, model: string, dims: number): Promise<{ queued: number; total: number }> {
  const nodes = await db.select().from(memoryNodes).where(eq(memoryNodes.sessionId, sessionId));
  const existing = await db.select().from(memoryEmbeddings).where(eq(memoryEmbeddings.sessionId, sessionId));
  const byId = new Map(existing.map((r) => [r.memoryNodeId, r]));
  const ids = nodes.filter((n) => { const old = byId.get(n.id); return !old || old.contentHash !== hashContent(model, String(dims), formatDocument(n.title, n.content)); }).map((n) => n.id);
  await enqueueEmbeddings(sessionId, ids, model, dims);
  const retried = await db.update(memoryEmbeddings).set({ status: "pending", attempts: 0, error: "", nextAttemptAt: new Date(), leaseToken: null, leaseExpiresAt: null }).where(and(eq(memoryEmbeddings.sessionId, sessionId), eq(memoryEmbeddings.status, "failed"))).returning({ id: memoryEmbeddings.id });
  return { queued: ids.length + retried.length, total: nodes.length };
}

/** Atomic short lease; provider calls run outside transactions. CAS rejects late results. */
export async function indexPendingEmbeddings(opts: { sessionId: string; keys: string[]; model: string; dims: number; limit?: number }): Promise<{ indexed: number; failed: number; pending: number }> {
  if (!opts.keys.length) return { indexed: 0, failed: 0, pending: 0 };
  const leaseToken = randomUUID();
  const now = new Date();
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`embedding:${opts.sessionId}`}))`);
    await tx.update(memoryEmbeddings).set({ status: "failed", leaseToken: null, leaseExpiresAt: null, error: "LEASE_RETRY_EXHAUSTED", updatedAt: now }).where(and(eq(memoryEmbeddings.sessionId, opts.sessionId), eq(memoryEmbeddings.status, "processing"), lte(memoryEmbeddings.leaseExpiresAt, now), sql`${memoryEmbeddings.attempts} >= 3`));
    const available = await tx.select().from(memoryEmbeddings).where(and(
      eq(memoryEmbeddings.sessionId, opts.sessionId), eq(memoryEmbeddings.model, opts.model), eq(memoryEmbeddings.dims, opts.dims), lt(memoryEmbeddings.attempts, 3),
      or(and(eq(memoryEmbeddings.status, "pending"), lte(memoryEmbeddings.nextAttemptAt, now)), and(eq(memoryEmbeddings.status, "processing"), lte(memoryEmbeddings.leaseExpiresAt, now))),
    )).orderBy(asc(memoryEmbeddings.updatedAt)).limit(Math.max(1, Math.min(opts.limit ?? 32, 64)));
    if (available.length) await tx.update(memoryEmbeddings).set({ status: "processing", attempts: sql`${memoryEmbeddings.attempts} + 1`, leaseToken, leaseExpiresAt: new Date(Date.now() + 45000) }).where(inArray(memoryEmbeddings.id, available.map((r) => r.id)));
    return available;
  });
  let indexed = 0, failed = 0;
  if (rows.length) {
    const nodes = await db.select().from(memoryNodes).where(and(eq(memoryNodes.sessionId, opts.sessionId), inArray(memoryNodes.id, rows.map((r) => r.memoryNodeId))));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const batch = rows.filter((r) => { const n = byId.get(r.memoryNodeId); return n && r.contentHash === hashContent(opts.model, String(opts.dims), formatDocument(n.title, n.content)); });
    const stale = rows.filter((r) => !batch.includes(r));
    if (stale.length) await enqueueEmbeddings(opts.sessionId, stale.map((r) => r.memoryNodeId), opts.model, opts.dims);
    try {
      const { vectors } = await embedTexts({ ...opts, texts: batch.map((r) => { const n = byId.get(r.memoryNodeId)!; return formatDocument(n.title, n.content); }) });
      for (let i = 0; i < batch.length; i++) {
        const row = batch[i];
        const saved = await db.update(memoryEmbeddings).set({ vector: vectors[i], status: "ready", attempts: row.attempts + 1, error: "", leaseToken: null, leaseExpiresAt: null, updatedAt: new Date() }).where(and(eq(memoryEmbeddings.id, row.id), eq(memoryEmbeddings.sessionId, opts.sessionId), eq(memoryEmbeddings.contentHash, row.contentHash), eq(memoryEmbeddings.leaseToken, leaseToken))).returning({ id: memoryEmbeddings.id });
        indexed += saved.length;
      }
    } catch (error) {
      for (const row of batch) {
        const attempts = row.attempts + 1;
        const updated = await db.update(memoryEmbeddings).set({ status: attempts >= 3 ? "failed" : "pending", attempts, error: error instanceof Error ? error.message.slice(0, 200) : "Ошибка индексации", leaseToken: null, leaseExpiresAt: null, nextAttemptAt: new Date(Date.now() + 5000 * 2 ** attempts), updatedAt: new Date() }).where(and(eq(memoryEmbeddings.id, row.id), eq(memoryEmbeddings.contentHash, row.contentHash), eq(memoryEmbeddings.leaseToken, leaseToken))).returning({ id: memoryEmbeddings.id });
        if (attempts >= 3) failed += updated.length;
      }
    }
  }
  const [remaining] = await db.select({ n: sql<number>`count(*)` }).from(memoryEmbeddings).where(and(eq(memoryEmbeddings.sessionId, opts.sessionId), inArray(memoryEmbeddings.status, ["pending", "processing"])));
  return { indexed, failed, pending: Number(remaining?.n ?? 0) };
}
export async function embeddingStats(sessionId: string, reader: Pick<typeof db, "select"> = db) {
  const rows = await reader.select({ status: memoryEmbeddings.status, model: memoryEmbeddings.model, n: sql<number>`count(*)` }).from(memoryEmbeddings).where(eq(memoryEmbeddings.sessionId, sessionId)).groupBy(memoryEmbeddings.status, memoryEmbeddings.model);
  const [total] = await reader.select({ n: sql<number>`count(*)` }).from(memoryNodes).where(eq(memoryNodes.sessionId, sessionId));
  const status: Record<string, number> = { ready: 0, pending: 0, processing: 0, failed: 0 };
  for (const row of rows) status[row.status] = Number(row.n);
  return { nodes: Number(total?.n ?? 0), ...status, models: [...new Set(rows.map((r) => r.model))] };
}
type SearchOptions = { sessionId: string; query: string; keys: string[]; model: string; dims: number; k?: number; currentTurn?: number; perLayerCap?: number; minSimilarity?: number; timeoutMs?: number };
export async function searchMemory(opts: SearchOptions) {
  const started = Date.now();
  const deadline = started + Math.max(1, Math.min(opts.timeoutMs ?? 15000, 30000));
  const [availability] = await runSearchQuery<{ migrated: boolean; ready: boolean }>(pool, {
    text: `SELECT to_regprocedure('chronicle_memory_vector(real[],integer)') IS NOT NULL
      AND to_regprocedure('chronicle_embedding_hash(text,integer,text,text)') IS NOT NULL AS migrated,
      EXISTS (SELECT 1 FROM memory_embeddings e JOIN memory_nodes n ON n.id = e.memory_node_id
        WHERE e.session_id = $1::uuid AND n.session_id = $1::uuid AND e.model = $2 AND e.dims = $3 AND e.status = 'ready') AS ready`,
    values: [opts.sessionId, opts.model, opts.dims],
  }, deadline);
  let databaseMs = Date.now() - started;
  if (!availability.ready) return { results: [] as RetrievedNode[], candidates: 0, ms: databaseMs, databaseMs, embeddingMs: 0, backend: availability.migrated ? "postgres" as const : "legacy" as const };
  // Rolling deployment only. A SQL error/timeout must never trigger a full-vector retry.
  if (!availability.migrated) {
    const result = await searchMemoryLegacy({ ...opts, timeoutMs: Math.max(1, deadline - Date.now()) });
    return { ...result, ms: Date.now() - started, databaseMs: null, embeddingMs: null, backend: "legacy" as const };
  }
  // Keep the old no-provider-call behavior when all ready rows are stale or invalid.
  const [usable] = await runSearchQuery<{ ready: boolean }>(pool, {
    text: `SELECT EXISTS (SELECT 1 FROM memory_embeddings e JOIN memory_nodes n ON n.id=e.memory_node_id
      WHERE e.session_id=$1::uuid AND n.session_id=$1::uuid AND e.model=$2 AND e.dims=$3 AND e.status='ready'
        AND e.content_hash=chronicle_embedding_hash(e.model,e.dims,n.title,n.content)
        AND chronicle_memory_vector(e.vector,$3::integer) IS NOT NULL) AS ready`,
    values: [opts.sessionId, opts.model, opts.dims],
  }, deadline);
  databaseMs = Date.now() - started;
  if (!usable.ready) return { results: [] as RetrievedNode[], candidates: 0, ms: databaseMs, databaseMs, embeddingMs: 0, backend: "postgres" as const };
  const embeddingStarted = Date.now();
  const key = hashContent(opts.sessionId, opts.model, String(opts.dims), opts.query);
  const q = await queryVectorCache.get(key, async () => {
    const remaining = deadline - Date.now();
    if (remaining < 250) throw new Error("MEMORY_SEARCH_TIMEOUT");
    return (await embedTexts({ ...opts, timeoutMs: remaining, texts: [formatQuery(opts.query)] })).vectors[0];
  }, { waitMs: Math.max(0, Math.min(750, deadline - Date.now() - 1000)) });
  const embeddingMs = Date.now() - embeddingStarted;
  const searchStarted = Date.now();
  const [result] = await runSearchQuery<DatabaseSearchResult>(pool, buildMemorySearchQuery({ ...opts, vector: q }), deadline);
  databaseMs += Date.now() - searchStarted;
  return { results: result.results.map(describeRetrievedNode), candidates: result.candidates, ms: Date.now() - started, databaseMs, embeddingMs, backend: "postgres" as const };
}

async function searchMemoryLegacy(opts: SearchOptions): Promise<{ results: RetrievedNode[]; candidates: number; ms: number }> {
  const started = Date.now();
  const candidates = await runSearchQuery<{ node: Omit<RetrievedNode, "similarity" | "score" | "why">; vector: number[]; hash: string }>(pool, {
    text: `SELECT jsonb_build_object('id',n.id,'layer',n.layer,'category',n.category,'title',n.title,'content',n.content,
      'importance',n.importance,'salience',n.salience,'source',n.source,'sourceTurn',n.source_turn,'turnTo',n.turn_to,'evidence',n.evidence) AS node,
      e.vector,e.content_hash AS hash FROM memory_embeddings e JOIN memory_nodes n ON n.id=e.memory_node_id
      WHERE e.session_id=$1::uuid AND n.session_id=$1::uuid AND e.status='ready' AND e.model=$2 AND e.dims=$3`,
    values: [opts.sessionId, opts.model, opts.dims],
  }, started + (opts.timeoutMs ?? 15000));
  const rows = candidates.filter((row) => isValidVector(row.vector, opts.dims) && row.hash === hashContent(opts.model, String(opts.dims), formatDocument(row.node.title, row.node.content)));
  if (!rows.length) return { results: [], candidates: 0, ms: Date.now() - started };
  const key = hashContent(opts.sessionId, opts.model, String(opts.dims), opts.query);
  const q = await queryVectorCache.get(key, async () => {
    const remaining = (opts.timeoutMs ?? 15_000) - (Date.now() - started);
    if (remaining < 250) throw new Error("Gemini не ответил вовремя");
    return (await embedTexts({ ...opts, timeoutMs: remaining, texts: [formatQuery(opts.query)] })).vectors[0];
  }, { waitMs: Math.max(0, Math.min(750, (opts.timeoutMs ?? 15_000) - (Date.now() - started) - 1_000)) });
  const scored: RetrievedNode[] = [];
  for (const row of rows) {
    const n = row.node;
    if (!isValidVector(row.vector, q.length) || row.hash !== hashContent(opts.model, String(opts.dims), formatDocument(n.title, n.content))) continue;
    const similarity = cosine(q, row.vector);
    if (similarity < (opts.minSimilarity ?? 0.35)) continue;
    const age = Math.max(0, (opts.currentTurn ?? 0) - (n.turnTo ?? 0));
    const provenance = n.source === "state" ? 1 : n.source === "seed" ? 0.95 : n.source === "compaction" ? 0.85 : 0.8;
    const score = similarity * 0.55 + n.importance / 100 * 0.2 + Math.max(0, 1 - age / 60) * 0.1 + n.salience / 100 * 0.05 + provenance * 0.1;
    scored.push({ id: n.id, layer: n.layer, category: n.category, title: n.title, content: n.content, importance: n.importance, salience: n.salience, source: n.source, sourceTurn: n.sourceTurn, turnTo: n.turnTo, evidence: n.evidence, similarity, score, why: `Сходство ${Math.round(similarity * 100)}% · ${n.source} · ход ${n.sourceTurn ?? 1}` });
  }
  scored.sort((a, b) => b.score - a.score);
  const perLayer: Record<string, number> = {};
  const results: RetrievedNode[] = [];
  for (const n of scored) {
    if ((perLayer[n.layer] ?? 0) >= (opts.perLayerCap ?? 4)) continue;
    perLayer[n.layer] = (perLayer[n.layer] ?? 0) + 1;
    results.push(n);
    if (results.length >= Math.max(1, Math.min(opts.k ?? 8, 20))) break;
  }
  return { results, candidates: scored.length, ms: Date.now() - started };
}
export function retrievedDigest(nodes: RetrievedNode[], maxChars = 2200): string {
  return nodes.map((n) => `• [${n.layer}] ${n.title}: ${n.content.slice(0, 260)}`).join("\n").slice(0, maxChars);
}
