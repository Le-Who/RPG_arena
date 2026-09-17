import { NextResponse } from "next/server";
import { db } from "@/db";
import { aiSettings, gameTurns, memoryNodes, tokenLogs } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { buildCompactionSystemPrompt, callGeminiWithRotation, estimateTokens } from "@/lib/gemini";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Ручная + автоматическая компакция: старшие модели 3.8/3.7/3.6 (Lite исключён для сохранения канона)
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const turns = await db.select().from(gameTurns).where(eq(gameTurns.sessionId, id)).orderBy(asc(gameTurns.turnNumber)).limit(200);
  const recent = turns.slice(-16);
  const text = recent.map((t) => `#${t.turnNumber} [${t.role}]: ${t.content.slice(0, 600)}`).join("\n");

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
        maxTokens: 1400,
      });

      const jsonStr = res.text.slice(res.text.indexOf("{"), res.text.lastIndexOf("}") + 1);
      const parsed = JSON.parse(jsonStr);
      const jobs: { layer: string; category: string; title: string; content: string; importance: number }[] = [];

      for (const e of parsed.episodic?.slice(0, 4) ?? []) {
        jobs.push({ layer: "episodic", category: "event", title: String(e.title).slice(0, 120), content: String(e.content).slice(0, 800), importance: Number(e.importance ?? 65) });
      }
      for (const s of parsed.semantic?.slice(0, 4) ?? []) {
        jobs.push({ layer: "semantic", category: "world", title: String(s.title).slice(0, 120), content: String(s.content).slice(0, 800), importance: Number(s.importance ?? 60) });
      }
      if (parsed.chronicle) {
        jobs.push({ layer: "chronicle", category: "event", title: `Хроника: ${new Date().toLocaleDateString("ru-RU")}`, content: String(parsed.chronicle).slice(0, 800), importance: 90 });
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
    // Эвристическая компакция
    const important = recent.filter((t) => t.role === "narrator" || t.role === "player").slice(-8);
    const digest = important.map((t) => `[#${t.turnNumber}] ${t.content.slice(0, 220)}`).join(" ‖ ").slice(0, 1200);
    await db.insert(memoryNodes).values({
      sessionId: id,
      layer: "episodic",
      category: "event",
      title: `Сводка ходов ${recent[0]?.turnNumber ?? 0}–${recent[recent.length - 1]?.turnNumber ?? 0}`,
      content: digest || "Ходы зафиксированы.",
      importance: 70,
      salience: 65,
      tokensEstimate: estimateTokens(digest),
      turnFrom: recent[0]?.turnNumber ?? 0,
      turnTo: recent[recent.length - 1]?.turnNumber ?? 0,
    });
    created = 1;
  }

  return NextResponse.json({ ok: true, created, mode });
}
