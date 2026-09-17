import { NextResponse } from "next/server";
import { getAIConfig } from "@/lib/ai-settings";
import { backfillSession, embeddingStats, indexPendingEmbeddings } from "@/lib/embeddings";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** POST /api/sessions/:id/memory/reindex — backfill + индексация pending (MEM-2c). */
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cfg = await getAIConfig();
  if (!cfg.keys.length) return NextResponse.json({ error: "NO_KEYS", message: "Нужен ключ Gemini" }, { status: 409 });
  const backfill = await backfillSession(id, cfg.embeddingModel, cfg.embeddingDims);
  let indexed = 0;
  let failed = 0;
  let pending = 0;
  // до 4 пачек по 32 за запрос — остальное доиндексируется после следующих ходов
  for (let i = 0; i < 4; i++) {
    const r = await indexPendingEmbeddings({ sessionId: id, keys: cfg.keys, model: cfg.embeddingModel, dims: cfg.embeddingDims, limit: 32 });
    indexed += r.indexed;
    failed += r.failed;
    pending = r.pending;
    if (!r.pending || (!r.indexed && !r.failed)) break;
  }
  const stats = await embeddingStats(id);
  return NextResponse.json({ ok: true, backfill, indexed, failed, pending, stats, model: cfg.embeddingModel, dims: cfg.embeddingDims });
}
