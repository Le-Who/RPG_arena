import { getAIConfig } from "@/lib/ai-settings";
import { runMemoryCycle } from "@/lib/background";
import { retryFailedMemoryJobs } from "@/lib/system-status";
import { httpError, HttpError, readJsonObject } from "@/lib/http";
import { currentProfileId } from "@/lib/identity";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function POST(req: Request) {
  try {
    const body = await readJsonObject(req, 2048);
    if (body.action === "retry") return Response.json({ ok: true, ...await retryFailedMemoryJobs() });
    if (body.action !== "process") throw new HttpError(400, "INVALID_INPUT", "Укажите process или retry.");
    const cfg = await getAIConfig();
    if (!cfg.keys.length) throw new HttpError(409, "AI_REQUIRED", "Сначала подключите Gemini. Задания уже сохранены и будут ждать в очереди.");
    if (!cfg.embeddingsEnabled && (!cfg.canUseLive || !cfg.semanticExtractionEnabled)) throw new HttpError(409, "DISABLED", "Обработка памяти выключена в настройках.");
    return Response.json({ ok: true, ...await runMemoryCycle({ source: "manual", ownerId: await currentProfileId() }) });
  } catch (error) { return httpError(error); }
}
