import { NextResponse } from "next/server";
import { db } from "@/db";
import { aiSettings, gameSessions, gameTurns, memoryNodes, tokenLogs } from "@/db/schema";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { buildCompactionSystemPrompt, callGeminiWithRotation, estimateTokens } from "@/lib/gemini";
import { assembleMemoryDigest } from "@/lib/memory";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Компакция памяти через Flash 3.8/3.7/3.6 (Lite исключён для сохранения канона).
// Fix #1: компактим только ходы после lastCompactTurn — исключаем повторное сжатие.
// Fix #2: desc+limit→asc исправляет проблему limit(500) при длинных кампаниях.
// maxTokens ответа: 2 400 — достаточно для детальной хроники + всех нод памяти.
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Fix #1 + #4: получаем сессию для точного lastCompactTurn.
  const sRows = await db.select().from(gameSessions).where(eq(gameSessions.id, id));
  if (!sRows[0]) return NextResponse.json({ error: "not found" }, { status: 404 });
  const session = sRows[0];
  const lastCompactTurn = (session.lastCompactTurn as number | null) ?? 0;

  // Fix #1 + #2: берём только новые ходы (turnNumber > lastCompactTurn), макс 30 штук.
  // Исключает повторное сжатие и корректно работает при любом числе ходов.
  const recent = await db
    .select()
    .from(gameTurns)
    .where(and(eq(gameTurns.sessionId, id), gt(gameTurns.turnNumber, lastCompactTurn)))
    .orderBy(asc(gameTurns.turnNumber))
    .limit(30);

  if (!recent.length) {
    return NextResponse.json({ ok: true, created: 0, mode: "skipped: no new turns since last compaction" });
  }

  const text = recent.map((t) => `#${t.turnNumber} [${t.role}]: ${t.content.slice(0, 1200)}`).join("\n");
  const newTurnFrom = recent[0]?.turnNumber ?? 0;
  const newTurnTo = recent[recent.length - 1]?.turnNumber ?? 0;

  // Fix #21: загружаем текущую память и передаём в промпт.
  // Модель не будет дублировать факты, которые уже есть в памяти.
  const existingMems = await db
    .select()
    .from(memoryNodes)
    .where(eq(memoryNodes.sessionId, id))
    .orderBy(desc(memoryNodes.importance))
    .limit(40);
  const existingDigest = assembleMemoryDigest(
    existingMems.map((m) => ({
      layer: m.layer,
      title: m.title,
      content: m.content,
      importance: m.importance,
      salience: m.salience,
      turnTo: m.turnTo ?? undefined,
    })),
    "flash",
    session.turnCount ?? 0,
  );

  const aiRows = await db.select().from(aiSettings).where(eq(aiSettings.id, "global"));
  const keys = (((aiRows[0]?.keys as string[]) ?? []).filter(Boolean)) as string[];
  const useLive = Boolean(aiRows[0]?.useLiveAI) && keys.length > 0;
  const preferredCompaction = aiRows[0]?.compactionModel || "gemini-3.8-flash";

  let created = 0;
  let mode = "heuristic";

  if (useLive) {
    try {
      const models = [preferredCompaction, "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"].filter(
        (m, i, arr) => arr.indexOf(m) === i,
      );

      const res = await callGeminiWithRotation({
        keys,
        models,
        system: buildCompactionSystemPrompt(),
        // Fix #21: существующая память в промпте — модель видит что уже зафиксировано
        user: `Существующая память (НЕ дублируй эти факты):\n${existingDigest}\n\nНовые ходы для сжатия (русский язык):\n${text}`,
        maxTokens: 2400,
      });

      const jsonStart = res.text.indexOf("{");
      const jsonEnd = res.text.lastIndexOf("}");
      if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
        throw new Error("NO_JSON_IN_RESPONSE");
      }
      const jsonStr = res.text.slice(jsonStart, jsonEnd + 1);
      const parsed = JSON.parse(jsonStr);
      const jobs: { layer: string; category: string; title: string; content: string; importance: number }[] = [];

      for (const e of parsed.episodic?.slice(0, 6) ?? []) {
        jobs.push({
          layer: "episodic",
          category: "event",
          title: String(e.title).slice(0, 120),
          content: String(e.content).slice(0, 800),
          importance: Number(e.importance ?? 65),
        });
      }
      for (const s of parsed.semantic?.slice(0, 6) ?? []) {
        jobs.push({
          layer: "semantic",
          category: "world",
          title: String(s.title).slice(0, 120),
          content: String(s.content).slice(0, 800),
          importance: Number(s.importance ?? 60),
        });
      }
      if (parsed.chronicle) {
        jobs.push({
          layer: "chronicle",
          category: "event",
          title: `Хроника: ${new Date().toLocaleDateString("ru-RU")}`,
          content: String(parsed.chronicle).slice(0, 1000),
          importance: 90,
        });
      }

      for (const j of jobs) {
        const imp = Math.max(5, Math.min(100, j.importance));
        await db.insert(memoryNodes).values({
          sessionId: id,
          layer: j.layer,
          category: j.category,
          title: j.title,
          content: j.content,
          importance: imp,
          // Fix #8: salience отражает importance вместо хардкода 75.
          // Механика salience decay получает смысл: важные ноды дольше остаются релевантными.
          salience: Math.min(95, Math.max(50, imp)),
          tokensEstimate: estimateTokens(j.content),
          turnFrom: newTurnFrom,
          turnTo: newTurnTo,
        });
        created++;
      }

      await db.insert(tokenLogs).values({
        sessionId: id,
        model: res.model,
        taskType: "compaction",
        promptTokens: estimateTokens(text) + estimateTokens(existingDigest),
        completionTokens: estimateTokens(res.text),
        totalTokens: estimateTokens(text) + estimateTokens(existingDigest) + estimateTokens(res.text),
        latencyMs: res.latencyMs,
        success: true,
      });
      mode = `gemini:${res.model}`;
    } catch (e) {
      mode = `heuristic (gemini fallback: ${e instanceof Error ? e.message.slice(0, 80) : "err"})`;
    }
  }

  if (created === 0) {
    // Улучшенный эвристический фолбэк: группируем по типам событий
    const narratorTurns = recent.filter((t) => t.role === "narrator").slice(-12);
    const playerTurns = recent.filter((t) => t.role === "player").slice(-12);

    // Эпизодическая нода: хронология событий от нарратора
    if (narratorTurns.length) {
      const narratorDigest = narratorTurns
        .map((t) => `[#${t.turnNumber}] ${t.content.slice(0, 300)}`)
        .join(" ‖ ")
        .slice(0, 1200);
      await db.insert(memoryNodes).values({
        sessionId: id,
        layer: "episodic",
        category: "event",
        title: `События ходов ${narratorTurns[0]?.turnNumber ?? 0}–${narratorTurns[narratorTurns.length - 1]?.turnNumber ?? 0}`,
        content: narratorDigest || "Ходы зафиксированы.",
        importance: 70,
        salience: 65,
        tokensEstimate: estimateTokens(narratorDigest),
        turnFrom: newTurnFrom,
        turnTo: newTurnTo,
      });
      created++;
    }

    // Хроника-нода: решения игрока
    if (playerTurns.length) {
      const playerDigest = playerTurns
        .map((t) => `[#${t.turnNumber}] ${t.content.slice(0, 200)}`)
        .join(" ‖ ")
        .slice(0, 800);
      await db.insert(memoryNodes).values({
        sessionId: id,
        layer: "chronicle",
        category: "event",
        title: `Решения игрока ходов ${playerTurns[0]?.turnNumber ?? 0}–${playerTurns[playerTurns.length - 1]?.turnNumber ?? 0}`,
        content: playerDigest || "Действия зафиксированы.",
        importance: 72,
        salience: 68,
        // Fix #20: estimateTokens вместо хардкода 100
        tokensEstimate: estimateTokens(playerDigest),
        turnFrom: newTurnFrom,
        turnTo: newTurnTo,
      });
      created++;
    }

    if (created === 0) {
      // Аварийный фолбэк — хотя бы один узел
      const emergencyContent = recent
        .map((t) => `[#${t.turnNumber}] ${t.content.slice(0, 150)}`)
        .join(" ‖ ")
        .slice(0, 1000) || "Ходы зафиксированы.";
      await db.insert(memoryNodes).values({
        sessionId: id,
        layer: "episodic",
        category: "event",
        title: `Сводка ходов ${recent[0]?.turnNumber ?? 0}–${recent[recent.length - 1]?.turnNumber ?? 0}`,
        content: emergencyContent,
        importance: 65,
        salience: 60,
        // Fix #20: реальная оценка токенов вместо хардкода 100
        tokensEstimate: estimateTokens(emergencyContent),
        turnFrom: newTurnFrom,
        turnTo: newTurnTo,
      });
      created = 1;
    }
  }

  // Fix #1 + #4: обновляем lastCompactTurn → следующая компакция возьмёт только новые ходы.
  // Это исключает бесконечное повторное сжатие одних и тех же событий.
  if (newTurnTo > 0) {
    await db
      .update(gameSessions)
      .set({ lastCompactTurn: newTurnTo, updatedAt: new Date() })
      .where(eq(gameSessions.id, id));
  }

  return NextResponse.json({ ok: true, created, mode });
}
