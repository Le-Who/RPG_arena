import { withCampaignAccess } from "@/lib/campaign-access";
import { after } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { gameSessions } from "@/db/schema";
import { getAIConfig } from "@/lib/ai-settings";
import { backfillSession, embeddingStats, indexPendingEmbeddings } from "@/lib/embeddings";
import { runMemoryCycle } from "@/lib/background";
import { httpError, HttpError, requireUuid } from "@/lib/http";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
async function handlePOST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params; requireUuid(id);
    const [session] = await db.select({ id: gameSessions.id }).from(gameSessions).where(eq(gameSessions.id, id));
    if (!session) throw new HttpError(404, "NOT_FOUND", "История не найдена.");
    const cfg = await getAIConfig();
    if (!cfg.keys.length) throw new HttpError(409, "NO_KEYS", "Нужен ключ Gemini.");
    if (!cfg.embeddingsEnabled) throw new HttpError(409, "DISABLED", "Индексация выключена в настройках.");
    const backfill = await backfillSession(id, cfg.embeddingModel, cfg.embeddingDims);
    const result = await indexPendingEmbeddings({ sessionId: id, keys: cfg.keys, model: cfg.embeddingModel, dims: cfg.embeddingDims, limit: 32 });
    if (result.pending) after(async () => { await runMemoryCycle({ sessionId: id, source: "after" }).catch(() => {}); });
    return Response.json({ ok: true, backfill, ...result, stats: await embeddingStats(id), model: cfg.embeddingModel, dims: cfg.embeddingDims });
  } catch (error) { return httpError(error); }
}

export const POST = withCampaignAccess("owner", handlePOST);
