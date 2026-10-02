import { getAIConfig } from "@/lib/ai-settings";
import { embedTexts, formatQuery } from "@/lib/embeddings";
import { withIdentityWork } from "@/lib/owner-work";
export const dynamic = "force-dynamic";
async function handlePOST() {
  try {
    const cfg = await getAIConfig();
    if (!cfg.keys.length) return Response.json({ error: "Сначала сохраните API-ключ." }, { status: 409 });
    const result = await embedTexts({ keys: cfg.keys, model: cfg.embeddingModel, dims: cfg.embeddingDims, texts: [formatQuery("История помнит ваши решения")], timeoutMs: 10000 });
    return Response.json({ ok: true, model: result.model, dims: result.vectors[0].length, latencyMs: result.latencyMs });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Не удалось подключиться" }, { status: 502 }); }
}
export const POST = withIdentityWork(handlePOST);
