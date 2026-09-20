import { and, asc, eq, gt, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { gameSessions, gameTurns } from "@/db/schema";
import { getAIConfig, logToken, pickModels } from "./ai-settings";
import { sessionOwnerId } from "./campaign-access";
import { callGeminiWithRotation } from "./gemini";
import { extractJsonObject } from "./resolution";
import { upsertMemoryNode, type UpsertNodeInput } from "./memory";
import { assertNoRunningTurn, lockSession } from "./turn-admission";
import { HttpError } from "./http";
export function textChunks(text: string, size = 740): string[] {
  const parts: string[] = []; let current = "";
  for (const char of text) { if (current.length + char.length > size && current) { parts.push(current); current = ""; } current += char; }
  if (current) parts.push(current);
  return parts;
}
export async function compactSession(sessionId: string) {
  const batch = await db.transaction(async (tx) => {
    await lockSession(tx, sessionId); await assertNoRunningTurn(tx, sessionId);
    const [session] = await tx.select().from(gameSessions).where(eq(gameSessions.id, sessionId));
    if (!session) throw new HttpError(404, "NOT_FOUND", "История не найдена.");
    const narrators = await tx.select().from(gameTurns).where(and(eq(gameTurns.sessionId, sessionId), eq(gameTurns.role, "narrator"), gt(gameTurns.turnNumber, session.lastCompactTurn), lte(gameTurns.turnNumber, session.turnCount))).orderBy(asc(gameTurns.turnNumber)).limit(6);
    if (!narrators.length) return null;
    const through = narrators[narrators.length - 1].turnNumber;
    const players = await tx.select().from(gameTurns).where(and(eq(gameTurns.sessionId, sessionId), eq(gameTurns.role, "player"), gt(gameTurns.turnNumber, session.lastCompactTurn), lte(gameTurns.turnNumber, through))).orderBy(asc(gameTurns.turnNumber));
    return { session, narrators, players, through };
  });
  if (!batch) return { ok: true, created: 0, mode: "up-to-date", turnTo: null };
  const cfg = await getAIConfig(await sessionOwnerId(sessionId)); const summaries = new Map<number, { content: string; evidence: string }>();
  if (cfg.canUseLive) {
    try {
      const { models } = await pickModels("compaction", cfg);
      if (models.length) {
        const response = await callGeminiWithRotation({ keys: cfg.keys, models, system: "Сожми каждый ответ рассказчика отдельно на русском: 2–4 предложения, только события исходного текста, без новых фактов. Сохрани решения, предметы и отношения. evidence — дословная цитата из соответствующего хода. Не переноси события между ходами. Верни JSON summaries: [{turnNumber, summary, evidence}].", user: JSON.stringify(batch.narrators.map((t) => ({ turnNumber: t.turnNumber, narration: t.content }))), responseSchema: { type: "object", properties: { summaries: { type: "array", items: { type: "object", properties: { turnNumber: { type: "integer" }, summary: { type: "string" }, evidence: { type: "string" } }, required: ["turnNumber", "summary", "evidence"] } } }, required: ["summaries"] }, maxTokens: 2600, temperature: 0.2, timeoutMs: 20000,
          onAttempt: async (a) => { if (!a.ok) await logToken({ sessionId, model: a.model, taskType: "compaction", promptTokens: 0, completionTokens: 0, latencyMs: a.latencyMs, success: false, error: a.error, keyIndex: a.keyIndex }); },
        });
        await logToken({ sessionId, model: response.model, taskType: "compaction", promptTokens: response.promptTokens, completionTokens: response.completionTokens, latencyMs: response.latencyMs, success: true, keyIndex: response.keyIndex });
        const parsed = extractJsonObject(response.text) as { summaries?: unknown } | null;
        if (Array.isArray(parsed?.summaries)) for (const item of parsed.summaries.slice(0, 6)) {
          if (!item || typeof item !== "object") continue;
          const row = item as Record<string, unknown>, turn = batch.narrators.find((t) => t.turnNumber === row.turnNumber);
          if (!turn || typeof row.summary !== "string" || row.summary.length < 20 || row.summary.length > 740 || typeof row.evidence !== "string" || row.evidence.length < 8 || row.evidence.length > 240 || !turn.content.includes(row.evidence)) continue;
          summaries.set(turn.turnNumber, { content: row.summary, evidence: row.evidence });
        }
      }
    } catch { /* keep full per-turn excerpts; no unverified partial summary is acknowledged */ }
  }
  const nodes: UpsertNodeInput[] = [];
  for (const turn of [...batch.narrators, ...batch.players]) {
    const summary = turn.role === "narrator" ? summaries.get(turn.turnNumber) : null;
    const label = turn.role === "player" ? "Намерение игрока — не подтверждённый исход" : summary ? "Сводка ответа рассказчика" : "Точный фрагмент ответа рассказчика";
    const pieces = summary ? [summary.content] : textChunks(turn.content);
    for (let index = 0; index < pieces.length; index++) nodes.push({ sessionId, layer: turn.role === "player" ? "chronicle" : "episodic", category: "event", title: `Ход ${turn.turnNumber} · ${turn.role === "player" ? "решение" : "события"}${pieces.length > 1 ? ` · ${index + 1}/${pieces.length}` : ""}`, content: `[${label}, ход ${turn.turnNumber}] ${pieces[index]}`, importance: turn.role === "player" ? 55 : 70, source: "compaction", sourceTurn: turn.turnNumber, turnFrom: turn.turnNumber, turnTo: turn.turnNumber, entityKey: `compact:${turn.turnNumber}:${turn.role}:${index}`, mode: "upsert", evidence: summary?.evidence ?? null, confidence: summary ? .8 : 1 });
  }
  return db.transaction(async (tx) => {
    await lockSession(tx, sessionId);
    const [current] = await tx.select({ lastCompactTurn: gameSessions.lastCompactTurn }).from(gameSessions).where(eq(gameSessions.id, sessionId));
    if (!current) throw new HttpError(404, "NOT_FOUND", "История уже удалена.");
    if (current.lastCompactTurn !== batch.session.lastCompactTurn) return { ok: true, created: 0, mode: "already-applied", turnTo: current.lastCompactTurn };
    let created = 0;
    for (const node of nodes) { const r = await upsertMemoryNode(node, tx); if (r.changed) created++; }
    await tx.update(gameSessions).set({ lastCompactTurn: batch.through }).where(and(eq(gameSessions.id, sessionId), eq(gameSessions.lastCompactTurn, batch.session.lastCompactTurn)));
    return { ok: true, created, mode: summaries.size ? "verified-summaries-and-excerpts" : "exact-excerpts", turnFrom: batch.session.lastCompactTurn + 1, turnTo: batch.through };
  });
}
