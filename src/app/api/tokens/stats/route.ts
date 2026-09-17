import { NextResponse } from "next/server";
import { db } from "@/db";
import { tokenLogs } from "@/db/schema";
import { desc, gte, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

function dayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function GET() {
  const since = dayStart();
  const today = await db.select().from(tokenLogs).where(gte(tokenLogs.createdAt, since)).orderBy(desc(tokenLogs.createdAt)).limit(500);

  const byModel: Record<string, { requests: number; tokens: number; errors: number }> = {};
  const byTask: Record<string, { requests: number; tokens: number }> = {};
  let totalTokens = 0;
  let totalReq = 0;
  let errors = 0;
  for (const l of today) {
    totalReq++;
    totalTokens += l.totalTokens ?? 0;
    if (!l.success) errors++;
    byModel[l.model] ??= { requests: 0, tokens: 0, errors: 0 };
    byModel[l.model].requests++;
    byModel[l.model].tokens += l.totalTokens ?? 0;
    if (!l.success) byModel[l.model].errors++;
    byTask[l.taskType] ??= { requests: 0, tokens: 0 };
    byTask[l.taskType].requests++;
    byTask[l.taskType].tokens += l.totalTokens ?? 0;
  }

  // счётчики по семействам для отображения квот 20 / 500
  const flashReq = Object.entries(byModel).filter(([k]) => !k.includes("lite") && !k.includes("offline") && !k.includes("player") && !k.includes("d20")).reduce((a, [, v]) => a + v.requests, 0);
  const perFlashModel: Record<string, number> = {};
  for (const [k, v] of Object.entries(byModel)) {
    if (k.includes("3.8") || k.includes("3.7") || k.includes("3.6")) perFlashModel[k] = v.requests;
  }
  const liteReq = Object.entries(byModel).filter(([k]) => k.includes("lite")).reduce((a, [, v]) => a + v.requests, 0);

  const recent = await db.select().from(tokenLogs).orderBy(desc(tokenLogs.createdAt)).limit(20);

  return NextResponse.json({
    today: { totalReq, totalTokens, errors, byModel, byTask, flashReq, liteReq, perFlashModel },
    quotas: {
      flashPerModel: 20,
      liteTotal: 500,
      flashModels: ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"],
      note: "20 запросов/день на каждую flash-модель, 500 — на lite. Маршрутизация бережёт старшие модели для нарратива и компакции.",
    },
    recent,
  });
}
