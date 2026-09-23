import { NextResponse } from "next/server";
import { db } from "@/db";
import { tokenLogs } from "@/db/schema";
import { and, eq, desc, sql } from "drizzle-orm";
import { currentProfileId } from "@/lib/identity";
import { getAIConfig } from "@/lib/ai-settings";
import { withIdentityWork } from "@/lib/owner-work";
import { quotaCap, quotaDay, quotaTimezone, quotaUsage } from "@/lib/quota";

export const dynamic = "force-dynamic";

async function handleGET() {
  try {
    const timezone = quotaTimezone(), day = quotaDay();
    const ownerId = await currentProfileId();
    const owner = eq(tokenLogs.ownerId, ownerId);
    const [today, cfg, recent] = await Promise.all([
      db.select().from(tokenLogs).where(and(owner,
        sql`${tokenLogs.createdAt} >= (${day}::date::timestamp AT TIME ZONE ${timezone}) AT TIME ZONE 'UTC'`,
        sql`${tokenLogs.createdAt} < ((${day}::date + 1)::timestamp AT TIME ZONE ${timezone}) AT TIME ZONE 'UTC'`,
      )).orderBy(desc(tokenLogs.createdAt)).limit(2000),
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
    const keyCount = cfg.keysSharedProject === false ? Math.max(1, cfg.keys.length) : 1;
    const [generationAttempts, embeddingAttempts] = await Promise.all([quotaUsage(ownerId), quotaUsage(ownerId, "embedding")]);
    const perFlashModel: Record<string, { used: number; cap: number }> = {};
    for (const id of ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"]) perFlashModel[id] = { used: generationAttempts[id] ?? 0, cap: cfg.limits.flash * keyCount };
    const liteReq = Object.entries(generationAttempts).filter(([k]) => k.includes("lite")).reduce((a, [, v]) => a + v, 0);
    const flashReq = Object.values(perFlashModel).reduce((a, v) => a + v.used, 0);
    const embeddingReq = Object.values(embeddingAttempts).reduce((a, v) => a + v, 0);
    return NextResponse.json({
      today: { totalReq, totalTokens, errors, byModel, byTask, flashReq, liteReq, embeddingReq, perFlashModel, liteCap: cfg.limits.lite * keyCount },
      quotas: {
        day, timezone, keysSharedProject: cfg.keysSharedProject !== false,
        generationAttempts, embeddingAttempts,
        embeddingCap: quotaCap(cfg, "embedding", cfg.embeddingModel),
        dailyEmbeddingLimit: cfg.dailyEmbeddingLimit ?? 5000,
        flashPerModel: cfg.limits.flash,
        liteTotal: cfg.limits.lite,
        keyCount: cfg.keys.length,
        enforced: cfg.enforceLimits,
        flashModels: ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"],
        note: cfg.enforceLimits
          ? `Локальный бюджет попыток HTTP на модель за день (${timezone}). ${cfg.keysSharedProject === false ? "Независимые проекты заявлены пользователем; бюджет умножен на число ключей." : "Все ключи делят один бюджет."} Один пакет эмбеддингов — одна попытка. Это не лимит расходов, RPM или TPM; квоты провайдера независимы.`
          : "Лимиты только отображаются (enforceLimits выключен). Фактические квоты определяет Gemini.",
      },
      recent,
    });
  } catch (err) {
    console.error("[tokens/stats GET]", err);
    return NextResponse.json({ error: "Не удалось получить статистику квот." }, { status: 500 });
  }
}
export const GET = withIdentityWork(handleGET);
