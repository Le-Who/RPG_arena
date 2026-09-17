import { NextResponse } from "next/server";
import { db } from "@/db";
import { gameSessions, gameTurns, memoryNodes } from "@/db/schema";
import { and, asc, eq, gt, lte, sql } from "drizzle-orm";
import { buildCompactionSystemPrompt, callGeminiWithRotation, estimateTokens } from "@/lib/gemini";
import { assembleMemoryDigest, loadRankedNodes, upsertMemoryNode } from "@/lib/memory";
import { getAIConfig, logToken, pickModels } from "@/lib/ai-settings";
import { profileFor } from "@/lib/profiles";
import { extractJsonObject } from "@/lib/resolution";
import { enqueueEmbeddings, indexPendingEmbeddings } from "@/lib/embeddings";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Компакция памяти: сжимает ходы после lastCompactTurn в episodic/semantic/chronicle-ноды
 * (source = compaction). Компакция НЕ меняет игровое состояние — только память.
 */
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sRows = await db.select().from(gameSessions).where(eq(gameSessions.id, id));
  if (!sRows[0]) return NextResponse.json({ error: "not found" }, { status: 404 });
  const session = sRows[0];
  const lastCompactTurn = session.lastCompactTurn ?? 0;
  const spec = profileFor(session.rulesProfile);

  const recent = await db
    .select()
    .from(gameTurns)
    .where(and(eq(gameTurns.sessionId, id), gt(gameTurns.turnNumber, lastCompactTurn)))
    .orderBy(asc(gameTurns.turnNumber), asc(gameTurns.createdAt))
    .limit(40);
  if (!recent.length) return NextResponse.json({ ok: true, created: 0, mode: "skipped: no new turns since last compaction" });

  const text = recent.map((t) => `#${t.turnNumber} [${t.role}]: ${t.content.slice(0, 1200)}`).join("\n");
  const newTurnFrom = recent[0].turnNumber;
  const newTurnTo = recent[recent.length - 1].turnNumber;

  const existingMems = await loadRankedNodes(id, 40);
  const existingDigest = assembleMemoryDigest(
    existingMems.map((m) => ({ id: m.id, layer: m.layer, title: m.title, content: m.content, importance: m.importance, salience: m.salience, turnTo: m.turnTo ?? undefined })),
    "flash",
    session.turnCount ?? 0,
  );

  const cfg = await getAIConfig();
  const touched: string[] = [];
  let created = 0;
  let mode = "heuristic";

  if (cfg.canUseLive) {
    try {
      const { models } = await pickModels("compaction", cfg);
      if (!models.length) throw new Error("DAILY_LIMIT: все compaction-модели исчерпаны");
      const res = await callGeminiWithRotation({
        keys: cfg.keys,
        models,
        system: buildCompactionSystemPrompt(spec.promptCanon),
        user: `Существующая память (НЕ дублируй эти факты):\n${existingDigest}\n\nНовые ходы для сжатия:\n${text}`,
        maxTokens: 2400,
        temperature: 0.4,
      });
      const parsed = extractJsonObject(res.text) as { episodic?: unknown[]; semantic?: unknown[]; chronicle?: unknown } | null;
      if (!parsed) throw new Error("NO_JSON_IN_RESPONSE");
      type Item = { title?: unknown; content?: unknown; importance?: unknown; entityKey?: unknown };
      const jobs: { layer: "episodic" | "semantic" | "chronicle"; category: string; title: string; content: string; importance: number; entityKey: string | null }[] = [];
      for (const e of ((parsed.episodic ?? []) as Item[]).slice(0, 6)) jobs.push({ layer: "episodic", category: "event", title: String(e.title ?? "Событие"), content: String(e.content ?? ""), importance: Number(e.importance ?? 65), entityKey: typeof e.entityKey === "string" && e.entityKey.includes(":") ? e.entityKey.slice(0, 80) : null });
      for (const s of ((parsed.semantic ?? []) as Item[]).slice(0, 6)) jobs.push({ layer: "semantic", category: "world", title: String(s.title ?? "Факт"), content: String(s.content ?? ""), importance: Number(s.importance ?? 60), entityKey: typeof s.entityKey === "string" && s.entityKey.includes(":") ? s.entityKey.slice(0, 80) : null });
      if (parsed.chronicle) jobs.push({ layer: "chronicle", category: "event", title: `Хроника ходов ${newTurnFrom}–${newTurnTo}`, content: String(parsed.chronicle), importance: 90, entityKey: `chronicle:${newTurnFrom}-${newTurnTo}` });
      for (const j of jobs) {
        if (!j.content || j.content.length < 12) continue;
        const r = await upsertMemoryNode({
          sessionId: id,
          layer: j.layer,
          category: j.category,
          title: j.title,
          content: j.content,
          importance: j.importance,
          source: "compaction",
          sourceTurn: newTurnTo,
          entityKey: j.entityKey,
          mode: j.entityKey && j.layer === "semantic" ? "upsert" : "append",
          turnFrom: newTurnFrom,
          turnTo: newTurnTo,
        });
        if (r.created || r.changed) {
          created++;
          touched.push(r.id);
        }
      }
      await logToken({ sessionId: id, model: res.model, taskType: "compaction", promptTokens: res.promptTokens, completionTokens: res.completionTokens, latencyMs: res.latencyMs, success: true, keyIndex: res.keyIndex });
      mode = `gemini:${res.model}`;
    } catch (e) {
      mode = `heuristic (gemini fallback: ${e instanceof Error ? e.message.slice(0, 80) : "err"})`;
    }
  }

  if (created === 0 && mode.startsWith("heuristic")) {
    // Детерминированный фолбэк: сводка ходов без интерпретации (не выдумывает фактов)
    const narratorTurns = recent.filter((t) => t.role === "narrator").slice(-12);
    const playerTurns = recent.filter((t) => t.role === "player").slice(-12);
    if (narratorTurns.length) {
      const digest = narratorTurns.map((t) => `[#${t.turnNumber}] ${t.content.slice(0, 300)}`).join(" ‖ ").slice(0, 1200);
      const r = await upsertMemoryNode({ sessionId: id, layer: "episodic", category: "event", title: `События ходов ${narratorTurns[0].turnNumber}–${narratorTurns[narratorTurns.length - 1].turnNumber}`, content: digest, importance: 70, source: "compaction", sourceTurn: newTurnTo, mode: "append", turnFrom: newTurnFrom, turnTo: newTurnTo });
      if (r.created) { created++; touched.push(r.id); }
    }
    if (playerTurns.length) {
      const digest = playerTurns.map((t) => `[#${t.turnNumber}] ${t.content.slice(0, 200)}`).join(" ‖ ").slice(0, 800);
      const r = await upsertMemoryNode({ sessionId: id, layer: "chronicle", category: "event", title: `Решения игрока ходов ${playerTurns[0].turnNumber}–${playerTurns[playerTurns.length - 1].turnNumber}`, content: digest, importance: 72, source: "compaction", sourceTurn: newTurnTo, mode: "append", turnFrom: newTurnFrom, turnTo: newTurnTo });
      if (r.created) { created++; touched.push(r.id); }
    }
  }

  if (newTurnTo > 0) {
    await db.update(gameSessions).set({ lastCompactTurn: newTurnTo, updatedAt: new Date() }).where(eq(gameSessions.id, id));
    // Чистим устаревшие единичные heuristic-ноды из уже сжатого диапазона (state/ai-semantic/seed не трогаем)
    try {
      await db
        .delete(memoryNodes)
        .where(and(eq(memoryNodes.sessionId, id), eq(memoryNodes.source, "heuristic"), lte(memoryNodes.turnTo, newTurnFrom - 1), sql`${memoryNodes.turnFrom} = ${memoryNodes.turnTo}`));
    } catch {
      /* best-effort */
    }
  }

  let embeddings: unknown = null;
  if (touched.length && cfg.keys.length && cfg.embeddingsEnabled) {
    try {
      await enqueueEmbeddings(id, touched, cfg.embeddingModel, cfg.embeddingDims);
      embeddings = await indexPendingEmbeddings({ sessionId: id, keys: cfg.keys, model: cfg.embeddingModel, dims: cfg.embeddingDims });
    } catch (e) {
      embeddings = { error: e instanceof Error ? e.message.slice(0, 120) : "err" };
    }
  }

  return NextResponse.json({ ok: true, created, mode, turnFrom: newTurnFrom, turnTo: newTurnTo, embeddings });
}
