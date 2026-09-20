import { withCampaignAccess } from "@/lib/campaign-access";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { memoryNodes } from "@/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { embeddingStats } from "@/lib/embeddings";

export const dynamic = "force-dynamic";

/** Статистика Memory House: слои, источники (provenance), токены, покрытие эмбеддингами. */
async function handleGET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [mems, emb] = await Promise.all([
    db.select().from(memoryNodes).where(eq(memoryNodes.sessionId, id)).orderBy(desc(sql`${memoryNodes.importance} * 0.7 + ${memoryNodes.salience} * 0.3`)).limit(80),
    embeddingStats(id).catch(() => null),
  ]);
  const byLayer: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  let tokens = 0;
  for (const m of mems) {
    byLayer[m.layer] = (byLayer[m.layer] ?? 0) + 1;
    bySource[m.source] = (bySource[m.source] ?? 0) + 1;
    tokens += m.tokensEstimate ?? 0;
  }
  return NextResponse.json({ memories: mems, stats: { total: mems.length, byLayer, bySource, tokens, embeddings: emb } });
}

export const GET = withCampaignAccess("owner", handleGET);
