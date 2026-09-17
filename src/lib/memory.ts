// ── Memory House: 5 слоёв + provenance + каноническая запись событий (MEM-1) ──
// Источники памяти по приоритету:
//   1) state       — подтверждённые изменения состояния (reducers), пишутся в транзакции хода;
//   2) ai-semantic — schema-constrained экстрактор (fastTaskModel), асинхронно и идемпотентно;
//   3) compaction  — сжатие уже подтверждённых ходов;
//   4) seed        — стартовый канон кампании.
// Keyword-эвристика удалена: она порождала жанрово-узкие и ложные ноды.

import { createHash } from "crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { memoryNodes, type MemorySource } from "@/db/schema";
import { estimateTokens } from "./gemini";
import type { MemoryEvent } from "./resolution";

export { LAYER_INFO, SOURCE_INFO, type MemoryLayer } from "./memory-ui";
import { LAYER_INFO } from "./memory-ui";
import type { MemoryLayer } from "./memory-ui";
export type ModelTier = "lite" | "flash";

export const CONTEXT_BUDGET: Record<ModelTier, number> = { lite: 7_500, flash: 16_000 };

export type DigestNode = {
  id?: string;
  layer: string;
  title: string;
  content: string;
  importance: number;
  salience: number;
  turnTo?: number;
  source?: string;
};

export function hashContent(...parts: string[]): string {
  return createHash("sha1").update(parts.join("\u241f")).digest("hex").slice(0, 32);
}

/**
 * Сборка дайджеста памяти для промпта с учётом бюджета, salience-decay и tier модели.
 * Lite → ≤8 000 символов, до 12 нод на слой; Flash → ≤14 000 символов, до 20 нод на слой.
 */
export function assembleMemoryDigest(nodes: DigestNode[], tier: ModelTier = "lite", currentTurn = 0, exclude?: Set<string>): string {
  const pool = exclude ? nodes.filter((n) => !n.id || !exclude.has(n.id)) : nodes;
  if (!pool.length) return "Пока пусто — начало истории.";
  const maxCharsPerNode = tier === "flash" ? 500 : 350;
  const maxNodesPerLayer = tier === "flash" ? 20 : 12;
  const hardCap = tier === "flash" ? 14_000 : 8_000;

  const effectiveSalience = (n: DigestNode): number => {
    if (n.layer === "chronicle" || !currentTurn || !n.turnTo) return n.salience;
    const age = Math.max(0, currentTurn - n.turnTo);
    return Math.max(0, n.salience - Math.min(30, age * 0.3));
  };
  const sorted = [...pool].sort((a, b) => b.importance * 0.7 + effectiveSalience(b) * 0.3 - (a.importance * 0.7 + effectiveSalience(a) * 0.3));
  const perLayer: Record<string, DigestNode[]> = {};
  for (const n of sorted) {
    perLayer[n.layer] ??= [];
    if (perLayer[n.layer].length < maxNodesPerLayer) perLayer[n.layer].push(n);
  }
  const parts: string[] = [];
  for (const layer of ["chronicle", "semantic", "procedural", "episodic"] as const) {
    const arr = perLayer[layer];
    if (arr?.length) parts.push(`[${layer.toUpperCase()}] ` + arr.map((n) => `${n.title}: ${n.content.slice(0, maxCharsPerNode)}`).join(" ‖ "));
  }
  const joined = parts.join("\n");
  return joined.length > hardCap ? joined.slice(0, hardCap) + "…" : joined;
}

/** Когда пора компактить: ≥ 24 действий игрока с последней компакции или переполнение рабочего окна. */
export function shouldCompact(playerTurnsSinceCompact: number, _unused: number, workingTokensEstimate: number, workingBudget = LAYER_INFO.working.budget): boolean {
  return playerTurnsSinceCompact >= 24 || workingTokensEstimate > workingBudget;
}

// ─────────────────────────────────────────────────────────────
//  Запись нод с provenance и дедупликацией (MEM-1a/e)
// ─────────────────────────────────────────────────────────────
export type UpsertNodeInput = {
  sessionId: string;
  layer: Exclude<MemoryLayer, "working">;
  category: string;
  title: string;
  content: string;
  importance: number;
  source: MemorySource;
  sourceTurn: number;
  entityKey?: string | null;
  mode?: "upsert" | "append";
  confidence?: number;
  evidence?: string | null;
  turnFrom?: number;
  turnTo?: number;
  salience?: number;
};

type Tx = Pick<typeof db, "select" | "insert" | "update" | "delete">;

/**
 * upsert-режим: если нода с таким entityKey есть — обновляем содержимое (факт о сущности эволюционирует).
 * append-режим: если нода с таким contentHash уже есть — пропускаем (идемпотентность), иначе создаём.
 * Возвращает id ноды и признак изменения содержимого (нужен для переиндексации эмбеддинга).
 */
export async function upsertMemoryNode(input: UpsertNodeInput, tx: Tx = db): Promise<{ id: string; changed: boolean; created: boolean }> {
  const title = input.title.slice(0, 120);
  const content = input.content.slice(0, 900);
  const contentHash = hashContent(input.layer, input.category, title, content);
  const importance = Math.max(5, Math.min(100, Math.round(input.importance)));
  const salience = input.salience ?? Math.min(95, Math.max(input.source === "ai-semantic" ? 45 : 50, importance));
  const mode = input.mode ?? (input.entityKey ? "upsert" : "append");

  if (mode === "upsert" && input.entityKey) {
    const existing = await tx
      .select({ id: memoryNodes.id, contentHash: memoryNodes.contentHash })
      .from(memoryNodes)
      .where(and(eq(memoryNodes.sessionId, input.sessionId), eq(memoryNodes.entityKey, input.entityKey)))
      .limit(1);
    if (existing[0]) {
      const changed = existing[0].contentHash !== contentHash;
      await tx
        .update(memoryNodes)
        .set({
          title,
          content,
          importance,
          salience,
          tokensEstimate: estimateTokens(content),
          contentHash,
          source: input.source,
          sourceTurn: input.sourceTurn,
          turnTo: input.turnTo ?? input.sourceTurn,
          confidence: input.confidence ?? 1,
          evidence: input.evidence ?? null,
          updatedAt: new Date(),
        })
        .where(eq(memoryNodes.id, existing[0].id));
      return { id: existing[0].id, changed, created: false };
    }
  } else {
    const dup = await tx
      .select({ id: memoryNodes.id })
      .from(memoryNodes)
      .where(and(eq(memoryNodes.sessionId, input.sessionId), eq(memoryNodes.contentHash, contentHash)))
      .limit(1);
    if (dup[0]) return { id: dup[0].id, changed: false, created: false };
  }

  const inserted = await tx
    .insert(memoryNodes)
    .values({
      sessionId: input.sessionId,
      layer: input.layer,
      category: input.category,
      title,
      content,
      importance,
      salience,
      tokensEstimate: estimateTokens(content),
      turnFrom: input.turnFrom ?? input.sourceTurn,
      turnTo: input.turnTo ?? input.sourceTurn,
      source: input.source,
      sourceTurn: input.sourceTurn,
      contentHash,
      entityKey: input.entityKey ?? null,
      confidence: input.confidence ?? 1,
      evidence: input.evidence ?? null,
    })
    .returning({ id: memoryNodes.id });
  return { id: inserted[0].id, changed: true, created: true };
}

/** Записать канонические события состояния (source = "state") — вызывается внутри транзакции хода. */
export async function writeStateEvents(sessionId: string, events: MemoryEvent[], turnNumber: number, tx: Tx = db): Promise<string[]> {
  const touched: string[] = [];
  for (const e of events.slice(0, 12)) {
    const r = await upsertMemoryNode(
      { sessionId, layer: e.layer, category: e.category, title: e.title, content: e.content, importance: e.importance, source: "state", sourceTurn: turnNumber, entityKey: e.entityKey, mode: e.mode },
      tx,
    );
    if (r.changed) touched.push(r.id);
  }
  return touched;
}

/** Ранжированная выборка нод для дайджеста (importance×0.7 + salience×0.3). */
export async function loadRankedNodes(sessionId: string, limit = 60) {
  return db
    .select()
    .from(memoryNodes)
    .where(eq(memoryNodes.sessionId, sessionId))
    .orderBy(desc(sql`${memoryNodes.importance} * 0.7 + ${memoryNodes.salience} * 0.3`))
    .limit(limit);
}

/** Валидированный факт экстрактора → нода ai-semantic (MEM-1b/d). */
export type ExtractedFact = {
  type: string;
  entityKey: string;
  title: string;
  content: string;
  evidence: string;
  importance: number;
  confidence: number;
};

export function normalizeExtractedFacts(raw: unknown, narration: string, playerAction: string): ExtractedFact[] {
  const out: ExtractedFact[] = [];
  const facts = Array.isArray((raw as { facts?: unknown })?.facts) ? ((raw as { facts: unknown[] }).facts as Record<string, unknown>[]) : [];
  const haystack = `${playerAction}\n${narration}`.toLowerCase();
  for (const f of facts.slice(0, 6)) {
    const content = typeof f.content === "string" ? f.content.trim().slice(0, 600) : "";
    const evidence = typeof f.evidence === "string" ? f.evidence.trim().slice(0, 240) : "";
    const confidence = Math.max(0, Math.min(1, Number(f.confidence ?? 0)));
    if (!content || content.length < 12) continue;
    // Доказательство должно реально присутствовать в тексте (защита от галлюцинаций)
    const evOk = evidence.length >= 8 && haystack.includes(evidence.toLowerCase().slice(0, 40));
    if (!evOk || confidence < 0.55) continue;
    // Не принимаем факты о ресурсах/предметах/локациях — они приходят из состояния (MEM-1c)
    if (/\b(hp|опыт|xp|золот|монет|кредит|предмет получ|подобрал|перешёл в|прибыл в)\b/i.test(content) && (f.type === "event" || f.type === "world")) continue;
    out.push({
      type: typeof f.type === "string" ? f.type : "world",
      entityKey: typeof f.entityKey === "string" ? f.entityKey.trim().slice(0, 80) : "",
      title: (typeof f.title === "string" ? f.title : content.slice(0, 60)).slice(0, 120),
      content,
      evidence,
      importance: Math.max(40, Math.min(95, Math.round(Number(f.importance ?? 55)))),
      confidence,
    });
  }
  return out;
}

export function layerForFactType(t: string): Exclude<MemoryLayer, "working"> {
  return t === "event" || t === "promise" ? "episodic" : "semantic";
}
