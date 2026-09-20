import { withCampaignAccess } from "@/lib/campaign-access";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { gameSessions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getAIConfig } from "@/lib/ai-settings";
import { searchMemory } from "@/lib/embeddings";

export const dynamic = "force-dynamic";

/** GET /api/sessions/:id/memory/search?q=…&k=8 — семантический поиск по памяти кампании (MEM-2f). */
async function handleGET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 500);
  const k = Math.max(1, Math.min(20, Number(url.searchParams.get("k") ?? 8) || 8));
  if (!q) return NextResponse.json({ error: "q required" }, { status: 400 });
  const s = await db.select({ turnCount: gameSessions.turnCount }).from(gameSessions).where(eq(gameSessions.id, id));
  if (!s[0]) return NextResponse.json({ error: "not found" }, { status: 404 });
  const cfg = await getAIConfig();
  if (!cfg.keys.length) return NextResponse.json({ error: "NO_KEYS", message: "Для семантического поиска нужен ключ Gemini" }, { status: 409 });
  if (!cfg.embeddingsEnabled) return NextResponse.json({ error: "DISABLED", message: "Эмбеддинги выключены в настройках" }, { status: 409 });
  try {
    const r = await searchMemory({ sessionId: id, query: q, keys: cfg.keys, model: cfg.embeddingModel, dims: cfg.embeddingDims, k, currentTurn: s[0].turnCount, minSimilarity: 0.2 });
    return NextResponse.json({ query: q, ...r, model: cfg.embeddingModel, dims: cfg.embeddingDims });
  } catch (e) {
    return NextResponse.json({ error: "SEARCH_FAILED", message: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

export const GET = withCampaignAccess("owner", handleGET);
