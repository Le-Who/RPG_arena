import { NextResponse } from "next/server";
import { db } from "@/db";
import { memoryNodes } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Fix #18: limit(60) выравнивает UI с контекстным окном промпта в act/route.ts
  const mems = await db.select().from(memoryNodes).where(eq(memoryNodes.sessionId, id)).orderBy(desc(memoryNodes.importance)).limit(60);
  const byLayer: Record<string, number> = {};
  let tokens = 0;
  for (const m of mems) {
    byLayer[m.layer] = (byLayer[m.layer] ?? 0) + 1;
    tokens += m.tokensEstimate ?? 0;
  }
  return NextResponse.json({ memories: mems, stats: { total: mems.length, byLayer, tokens } });
}
