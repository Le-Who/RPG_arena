import { NextResponse } from "next/server";
import { db } from "@/db";
import { aiSettings, gameTurns, memoryNodes, tokenLogs } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { buildCompactionSystemPrompt, callGeminiWithRotation, estimateTokens } from "@/lib/gemini";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Ручная + автоматическая компакция через Flash 3.8/3.7/3.6 (Lite исключён для сохранения канона).
// Окно: последние 30 ходов × 1 200 символов ≈ 10 000–12 000 токенов — в sweet-spot Flash 3.8.
// maxTokens для ответа: 2 400 (хватает на детальную хронику + все ноды памяти без обрезания).
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const turns = await db.select().from(gameTurns).where(eq(gameTurns.sessionId, id)).orderBy(asc(gameTurns.turnNumber)).limit(500);
  // Берём последние 30 ходов для компакции (sweet-spot Flash 3.8: 16k–28k токенов)
  const recent = turns.slice(-30);
  const text = recent.map((t) => `#${t.turnNumber} [${t.role}]: ${t.content.slice(0, 1200)}`).join("\n");

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
        user: `Сожми эти ходы в память (русский язык):\n${text}`,
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
        jobs.push({ layer: "episodic", category: "event", title: String(e.title).slice(0, 120), content: String(e.content).slice(0, 800), importance: Number(e.importance ?? 65) });
      }
      for (const s of parsed.semantic?.slice(0, 6) ?? []) {
        jobs.push({ layer: "semantic", category: "world", title: String(s.title).slice(0, 120), content: String(s.content).slice(0, 800), importance: Number(s.importance ?? 60) });
      }
      if (parsed.chronicle) {
        jobs.push({ layer: "chronicle", category: "event", title: `Хроника: ${new Date().toLocaleDateString("ru-RU")}`, content: String(parsed.chronicle).slice(0, 1000), importance: 90 });
      }

      for (const j of jobs) {
        await db.insert(memoryNodes).values({
          sessionId: id,
          layer: j.layer,
          category: j.category,
          title: j.title,
          content: j.content,
          importance: Math.max(5, Math.min(100, j.importance)),
          salience: 75,
          tokensEstimate: estimateTokens(j.content),
          turnFrom: recent[0]?.turnNumber ?? 0,
          turnTo: recent[recent.length - 1]?.turnNumber ?? 0,
        });
        created++;
      }

      await db.insert(tokenLogs).values({
        sessionId: id,
        model: res.model,
        taskType: "compaction",
        promptTokens: estimateTokens(text),
        completionTokens: estimateTokens(res.text),
        totalTokens: estimateTokens(text) + estimateTokens(res.text),
        latencyMs: res.latencyMs,
        success: true,
      });
      mode = `gemini:${res.model}`;
    } catch (e) {
      mode = `heuristic (gemini fallback: ${e instanceof Error ? e.message.slice(0, 80) : "err"})`;
    }
  }

  if (created === 0) {
    // Улучшенный эвристический фолбэк: группируем по типам событий вместо единого монолитного дайджеста
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
        turnFrom: narratorTurns[0]?.turnNumber ?? 0,
        turnTo: narratorTurns[narratorTurns.length - 1]?.turnNumber ?? 0,
      });
      created++;
    }

    // Хроника-нода: действия и решения игрока
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
        tokensEstimate: estimateTokens(playerDigest),
        turnFrom: playerTurns[0]?.turnNumber ?? 0,
        turnTo: playerTurns[playerTurns.length - 1]?.turnNumber ?? 0,
      });
      created++;
    }

    if (created === 0) {
      // Аварийный фолбэк — хотя бы один узел
      await db.insert(memoryNodes).values({
        sessionId: id,
        layer: "episodic",
        category: "event",
        title: `Сводка ходов ${recent[0]?.turnNumber ?? 0}–${recent[recent.length - 1]?.turnNumber ?? 0}`,
        content: recent.map((t) => `[#${t.turnNumber}] ${t.content.slice(0, 150)}`).join(" ‖ ").slice(0, 1000) || "Ходы зафиксированы.",
        importance: 65,
        salience: 60,
        tokensEstimate: 100,
        turnFrom: recent[0]?.turnNumber ?? 0,
        turnTo: recent[recent.length - 1]?.turnNumber ?? 0,
      });
      created = 1;
    }
  }

  return NextResponse.json({ ok: true, created, mode });
}
