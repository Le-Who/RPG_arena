// ── MEM-2: эмбеддинги памяти на gemini-embedding-2 ──────────
// · Провайдер изолирован: embedTexts() — единственная точка вызова REST.
// · Хранилище: memory_embeddings (model, dims, contentHash, status, vector real[]).
// · Индексация — outbox: нода → pending → ready/failed; retry/backfill не блокируют ход.
// · Поиск всегда фильтруется по sessionId; cosine считается в приложении (сессия — сотни нод),
//   что переносимо на любой PostgreSQL. При наличии pgvector путь можно заменить на SQL `<=>`.
// · gemini-embedding-2 не принимает task_type: используем префиксы задач из документации
//   («task: search result | query: …» / «title: … | text: …»).

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { memoryEmbeddings, memoryNodes, tokenLogs } from "@/db/schema";
import { estimateTokens } from "./gemini";
import { hashContent } from "./memory";

export const EMBEDDING_MODEL_ALIASES = ["gemini-embedding-2", "gemini-embedding-2-preview"];
export const DEFAULT_EMBEDDING_DIMS = 768;

export function formatDocument(title: string, content: string): string {
  return `title: ${title || "none"} | text: ${content}`.slice(0, 6000);
}
export function formatQuery(q: string): string {
  return `task: search result | query: ${q}`.slice(0, 4000);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function modelFamily(m: string) {
  return m.replace(/-preview$/, "").replace(/-\d{2}-\d{4}$/, "");
}

// ─────────────────────────────────────────────────────────────
//  Провайдер
// ─────────────────────────────────────────────────────────────
export async function embedTexts(opts: {
  keys: string[];
  model: string;
  dims: number;
  texts: string[];
  sessionId?: string | null;
  timeoutMs?: number;
}): Promise<{ vectors: number[][]; model: string; latencyMs: number }> {
  const { keys, texts } = opts;
  if (!keys.length) throw new Error("NO_KEYS");
  if (!texts.length) return { vectors: [], model: opts.model, latencyMs: 0 };
  const models = [opts.model, ...EMBEDDING_MODEL_ALIASES.filter((m) => m !== opts.model)];
  let lastErr = "unknown";
  for (const model of models) {
    for (let ki = 0; ki < keys.length; ki++) {
      const started = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
      try {
        const isBatch = texts.length > 1;
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${isBatch ? "batchEmbedContents" : "embedContent"}`;
        const body = isBatch
          ? { requests: texts.map((t) => ({ model: `models/${model}`, content: { parts: [{ text: t }] }, outputDimensionality: opts.dims })) }
          : { model: `models/${model}`, content: { parts: [{ text: texts[0] }] }, outputDimensionality: opts.dims };
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": keys[ki] },
          signal: ctrl.signal,
          body: JSON.stringify(body),
        });
        const latencyMs = Date.now() - started;
        if (!res.ok) {
          const t = await res.text();
          lastErr = `HTTP ${res.status}: ${t.slice(0, 200)}`;
          await logEmbeddingCall(opts.sessionId, model, texts, latencyMs, false, lastErr, ki);
          if (res.status === 400 || res.status === 404) break; // модель недоступна — следующий алиас
          continue; // 429/5xx — следующий ключ
        }
        const data = await res.json();
        const vectors: number[][] = isBatch
          ? ((data?.embeddings ?? []) as { values?: number[] }[]).map((e) => e.values ?? [])
          : [((data?.embedding ?? {}) as { values?: number[] }).values ?? []];
        if (vectors.length !== texts.length || vectors.some((v) => !v.length)) {
          lastErr = "EMPTY_EMBEDDING";
          await logEmbeddingCall(opts.sessionId, model, texts, latencyMs, false, lastErr, ki);
          continue;
        }
        await logEmbeddingCall(opts.sessionId, model, texts, latencyMs, true, "", ki);
        return { vectors, model, latencyMs };
      } catch (e) {
        lastErr = e instanceof Error ? (e.name === "AbortError" ? "TIMEOUT" : e.message) : String(e);
        await logEmbeddingCall(opts.sessionId, model, texts, Date.now() - started, false, lastErr, ki);
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw new Error(`EMBEDDING_FAILED: ${lastErr}`);
}

async function logEmbeddingCall(sessionId: string | null | undefined, model: string, texts: string[], latencyMs: number, success: boolean, error: string, keyIndex: number) {
  const promptTokens = texts.reduce((a, t) => a + estimateTokens(t), 0);
  try {
    await db.insert(tokenLogs).values({ sessionId: sessionId ?? null, model, taskType: "embedding", promptTokens, completionTokens: 0, totalTokens: promptTokens, latencyMs, success, error, keyIndex });
  } catch {
    /* лог не должен ломать игровой путь */
  }
}

// ─────────────────────────────────────────────────────────────
//  Outbox: постановка в очередь, индексация, backfill
// ─────────────────────────────────────────────────────────────
export async function enqueueEmbeddings(sessionId: string, nodeIds: string[], model: string, dims: number) {
  if (!nodeIds.length) return;
  const nodes = await db.select({ id: memoryNodes.id, title: memoryNodes.title, content: memoryNodes.content }).from(memoryNodes).where(inArray(memoryNodes.id, nodeIds));
  for (const n of nodes) {
    const contentHash = hashContent(model, String(dims), formatDocument(n.title, n.content));
    await db
      .insert(memoryEmbeddings)
      .values({ memoryNodeId: n.id, sessionId, model, dims, contentHash, status: "pending", attempts: 0, error: "", vector: null })
      .onConflictDoUpdate({
        target: memoryEmbeddings.memoryNodeId,
        set: { model, dims, contentHash, status: "pending", attempts: 0, error: "", vector: null, updatedAt: new Date() },
        setWhere: sql`${memoryEmbeddings.contentHash} <> excluded.content_hash`,
      });
  }
}

/** Пометить pending все ноды сессии без актуального эмбеддинга (новая модель/размерность/контент). */
export async function backfillSession(sessionId: string, model: string, dims: number): Promise<{ queued: number; total: number }> {
  const nodes = await db.select({ id: memoryNodes.id, title: memoryNodes.title, content: memoryNodes.content }).from(memoryNodes).where(eq(memoryNodes.sessionId, sessionId));
  const existing = await db
    .select({ memoryNodeId: memoryEmbeddings.memoryNodeId, contentHash: memoryEmbeddings.contentHash, status: memoryEmbeddings.status })
    .from(memoryEmbeddings)
    .where(eq(memoryEmbeddings.sessionId, sessionId));
  const byNode = new Map(existing.map((e) => [e.memoryNodeId, e]));
  const toQueue: string[] = [];
  for (const n of nodes) {
    const h = hashContent(model, String(dims), formatDocument(n.title, n.content));
    const cur = byNode.get(n.id);
    if (!cur || cur.contentHash !== h || cur.status === "failed") toQueue.push(n.id);
  }
  // Принудительно: reset failed → pending даже при совпадении хеша
  if (toQueue.length) {
    const nodesToQueue = nodes.filter((n) => toQueue.includes(n.id));
    for (const n of nodesToQueue) {
      const contentHash = hashContent(model, String(dims), formatDocument(n.title, n.content));
      await db
        .insert(memoryEmbeddings)
        .values({ memoryNodeId: n.id, sessionId, model, dims, contentHash, status: "pending", attempts: 0, error: "", vector: null })
        .onConflictDoUpdate({ target: memoryEmbeddings.memoryNodeId, set: { model, dims, contentHash, status: "pending", attempts: 0, error: "", vector: null, updatedAt: new Date() } });
    }
  }
  return { queued: toQueue.length, total: nodes.length };
}

/** Проиндексировать пачку pending-нод. Идемпотентно; ошибки копятся в attempts/error. */
export async function indexPendingEmbeddings(opts: { sessionId: string; keys: string[]; model: string; dims: number; limit?: number }): Promise<{ indexed: number; failed: number; pending: number }> {
  const rows = await db
    .select({ id: memoryEmbeddings.id, memoryNodeId: memoryEmbeddings.memoryNodeId, attempts: memoryEmbeddings.attempts })
    .from(memoryEmbeddings)
    .where(and(eq(memoryEmbeddings.sessionId, opts.sessionId), eq(memoryEmbeddings.status, "pending")))
    .orderBy(desc(memoryEmbeddings.updatedAt))
    .limit(opts.limit ?? 32);
  if (!rows.length) return { indexed: 0, failed: 0, pending: 0 };

  const nodes = await db
    .select({ id: memoryNodes.id, title: memoryNodes.title, content: memoryNodes.content })
    .from(memoryNodes)
    .where(inArray(memoryNodes.id, rows.map((r) => r.memoryNodeId)));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const batch = rows.filter((r) => nodeById.has(r.memoryNodeId));
  const texts = batch.map((r) => formatDocument(nodeById.get(r.memoryNodeId)!.title, nodeById.get(r.memoryNodeId)!.content));

  let indexed = 0;
  let failed = 0;
  try {
    const { vectors, model } = await embedTexts({ keys: opts.keys, model: opts.model, dims: opts.dims, texts, sessionId: opts.sessionId });
    for (let i = 0; i < batch.length; i++) {
      await db
        .update(memoryEmbeddings)
        .set({ vector: vectors[i], status: "ready", model, dims: vectors[i].length, error: "", attempts: batch[i].attempts + 1, updatedAt: new Date() })
        .where(eq(memoryEmbeddings.id, batch[i].id));
      indexed++;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 200) : String(e);
    for (const r of batch) {
      const attempts = r.attempts + 1;
      await db
        .update(memoryEmbeddings)
        .set({ attempts, error: msg, status: attempts >= 3 ? "failed" : "pending", updatedAt: new Date() })
        .where(eq(memoryEmbeddings.id, r.id));
      if (attempts >= 3) failed++;
    }
  }
  const pendingRows = await db
    .select({ c: sql<number>`count(*)` })
    .from(memoryEmbeddings)
    .where(and(eq(memoryEmbeddings.sessionId, opts.sessionId), eq(memoryEmbeddings.status, "pending")));
  return { indexed, failed, pending: Number(pendingRows[0]?.c ?? 0) };
}

export async function embeddingStats(sessionId: string) {
  const rows = await db
    .select({ status: memoryEmbeddings.status, model: memoryEmbeddings.model, c: sql<number>`count(*)` })
    .from(memoryEmbeddings)
    .where(eq(memoryEmbeddings.sessionId, sessionId))
    .groupBy(memoryEmbeddings.status, memoryEmbeddings.model);
  const total = await db.select({ c: sql<number>`count(*)` }).from(memoryNodes).where(eq(memoryNodes.sessionId, sessionId));
  const byStatus: Record<string, number> = { ready: 0, pending: 0, failed: 0 };
  const models = new Set<string>();
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + Number(r.c);
    models.add(r.model);
  }
  return { nodes: Number(total[0]?.c ?? 0), ...byStatus, models: [...models] };
}

// ─────────────────────────────────────────────────────────────
//  Hybrid retrieval (MEM-2d)
// ─────────────────────────────────────────────────────────────
export type RetrievedNode = {
  id: string;
  layer: string;
  category: string;
  title: string;
  content: string;
  importance: number;
  salience: number;
  source: string;
  sourceTurn: number | null;
  turnTo: number | null;
  evidence: string | null;
  similarity: number;
  score: number;
  why: string;
};

export async function searchMemory(opts: {
  sessionId: string;
  query: string;
  keys: string[];
  model: string;
  dims: number;
  k?: number;
  currentTurn?: number;
  perLayerCap?: number;
  minSimilarity?: number;
}): Promise<{ results: RetrievedNode[]; candidates: number; ms: number }> {
  const started = Date.now();
  const k = opts.k ?? 8;
  const { vectors } = await embedTexts({ keys: opts.keys, model: opts.model, dims: opts.dims, texts: [formatQuery(opts.query)], sessionId: opts.sessionId });
  const q = vectors[0];
  const family = modelFamily(opts.model);

  const rows = await db
    .select({
      vector: memoryEmbeddings.vector,
      model: memoryEmbeddings.model,
      id: memoryNodes.id,
      layer: memoryNodes.layer,
      category: memoryNodes.category,
      title: memoryNodes.title,
      content: memoryNodes.content,
      importance: memoryNodes.importance,
      salience: memoryNodes.salience,
      source: memoryNodes.source,
      sourceTurn: memoryNodes.sourceTurn,
      turnTo: memoryNodes.turnTo,
      evidence: memoryNodes.evidence,
    })
    .from(memoryEmbeddings)
    .innerJoin(memoryNodes, eq(memoryEmbeddings.memoryNodeId, memoryNodes.id))
    .where(and(eq(memoryEmbeddings.sessionId, opts.sessionId), eq(memoryEmbeddings.status, "ready"), eq(memoryEmbeddings.dims, q.length)));

  const currentTurn = opts.currentTurn ?? 0;
  const minSim = opts.minSimilarity ?? 0.35;
  const scored: RetrievedNode[] = [];
  for (const r of rows) {
    if (!r.vector || modelFamily(r.model) !== family) continue;
    const similarity = cosine(q, r.vector);
    if (similarity < minSim) continue;
    const age = currentTurn && r.turnTo ? Math.max(0, currentTurn - r.turnTo) : 0;
    const recency = currentTurn ? Math.max(0, 1 - age / 60) : 0.5;
    const provenance = r.source === "state" ? 1 : r.source === "seed" ? 0.95 : r.source === "compaction" ? 0.85 : r.source === "ai-semantic" ? 0.8 : 0.5;
    const score = similarity * 0.55 + (r.importance / 100) * 0.2 + recency * 0.1 + (r.salience / 100) * 0.05 + provenance * 0.1;
    scored.push({
      id: r.id,
      layer: r.layer,
      category: r.category,
      title: r.title,
      content: r.content,
      importance: r.importance,
      salience: r.salience,
      source: r.source,
      sourceTurn: r.sourceTurn,
      turnTo: r.turnTo,
      evidence: r.evidence,
      similarity,
      score,
      why: `сходство ${(similarity * 100).toFixed(0)}% · важность ${Math.round(r.importance)} · ${r.source}${r.sourceTurn ? ` · ход ${r.sourceTurn}` : ""}`,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  // Разнообразие слоёв: не более perLayerCap нод одного слоя
  const cap = opts.perLayerCap ?? 4;
  const perLayer: Record<string, number> = {};
  const results: RetrievedNode[] = [];
  for (const s of scored) {
    if ((perLayer[s.layer] ?? 0) >= cap) continue;
    perLayer[s.layer] = (perLayer[s.layer] ?? 0) + 1;
    results.push(s);
    if (results.length >= k) break;
  }
  return { results, candidates: scored.length, ms: Date.now() - started };
}

export function retrievedDigest(nodes: RetrievedNode[], maxChars = 2200): string {
  if (!nodes.length) return "";
  const parts = nodes.map((n) => `• [${n.layer}] ${n.title}: ${n.content.slice(0, 260)}`);
  const joined = parts.join("\n");
  return joined.length > maxChars ? joined.slice(0, maxChars) + "…" : joined;
}
