import { NextResponse } from "next/server";
import { db } from "@/db";
import { tokenLogs } from "@/db/schema";
import { and, eq, desc, gte } from "drizzle-orm";
import { currentProfileId } from "@/lib/identity";
import { getAIConfig } from "@/lib/ai-settings";
import { withIdentityWork } from "@/lib/owner-work";

export const dynamic = "force-dynamic";

function dayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

async function handleGET() {
  try {
    const since = dayStart();
    const owner = eq(tokenLogs.ownerId, await currentProfileId());
    const [today, cfg, recent] = await Promise.all([
      db.select().from(tokenLogs).where(and(owner, gte(tokenLogs.createdAt, since))).orderBy(desc(tokenLogs.createdAt)).limit(2000),
      getAIConfig(),
      db.select().from(tokenLogs).where(owner).orderBy(desc(tokenLogs.createdAt)).limit(20),
    ]);
    const byModel: Record<string, { requests: number; tokens: number; errors: number; avgLatencyMs: number }> = {};
    const byTask: Record<string, { requests: number; tokens: number }> = {};
    let totalTokens = 0;
    let totalReq = 0;
    let errors = 0;
    for (const l of today) {
      totalReq++;
      totalTokens += l.totalTokens ?? 0;
      if (!l.success) errors++;
      byModel[l.model] ??= { requests: 0, tokens: 0, errors: 0, avgLatencyMs: 0 };
      const m = byModel[l.model];
      m.avgLatencyMs = Math.round((m.avgLatencyMs * m.requests + (l.latencyMs ?? 0)) / (m.requests + 1));
      m.requests++;
      m.tokens += l.totalTokens ?? 0;
      if (!l.success) m.errors++;
      byTask[l.taskType] ??= { requests: 0, tokens: 0 };
      byTask[l.taskType].requests++;
      byTask[l.taskType].tokens += l.totalTokens ?? 0;
    }
    const keyCount = Math.max(1, cfg.keys.length);
    const perFlashModel: Record<string, { used: number; cap: number }> = {};
    for (const id of ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"]) perFlashModel[id] = { used: byModel[id]?.requests ?? 0, cap: cfg.limits.flash * keyCount };
    const liteReq = Object.entries(byModel).filter(([k]) => k.includes("lite")).reduce((a, [, v]) => a + v.requests, 0);
    const flashReq = Object.values(perFlashModel).reduce((a, v) => a + v.used, 0);
    const embeddingReq = Object.entries(byModel).filter(([k]) => k.includes("embedding")).reduce((a, [, v]) => a + v.requests, 0);
    return NextResponse.json({
      today: { totalReq, totalTokens, errors, byModel, byTask, flashReq, liteReq, embeddingReq, perFlashModel, liteCap: cfg.limits.lite * keyCount },
      quotas: {
        flashPerModel: cfg.limits.flash,
        liteTotal: cfg.limits.lite,
        keyCount: cfg.keys.length,
        enforced: cfg.enforceLimits,
        flashModels: ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"],
        note: cfg.enforceLimits
          ? `Лимиты применяются сервером: ${cfg.limits.flash}/день на flash-модель и ${cfg.limits.lite}/день на lite — на каждый ключ (${keyCount}).`
          : "Лимиты только отображаются (enforceLimits выключен). Фактические квоты определяет Gemini.",
      },
      recent,
    });
  } catch (err) {
    console.error("[tokens/stats GET]", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
export const GET = withIdentityWork(handleGET);
