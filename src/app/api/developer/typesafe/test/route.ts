import { getTypeSafePilotConfig } from "@/lib/typesafe-settings";
import { logToken } from "@/lib/ai-settings";
import { TYPE_SAFE_MODEL, verifyTypeSafeFacts } from "@/lib/typesafe";
import { httpError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const config = await getTypeSafePilotConfig();
    if (!config.apiKey) return Response.json({ ok: false, code: "NO_KEY", message: "Сначала сохраните ключ TypeSafe в своём профиле." }, { status: 409 });
    const report = await verifyTypeSafeFacts({
      enabled: true,
      apiKey: config.apiKey,
      narration: "Страж открыл ворота и впустил героя в город.",
      playerAction: "Попросить стража открыть ворота.",
      facts: [{ type: "event", entityKey: "test:gate", title: "Ворота открыты", content: "Страж открыл ворота и впустил героя в город.", evidence: "Страж открыл ворота", importance: 50, confidence: 0.9 }],
    });
    await logToken({ sessionId: null, model: TYPE_SAFE_MODEL, taskType: "typesafe-verification", promptTokens: report.usage?.inputTokens ?? 0, completionTokens: report.usage?.outputTokens ?? 0, latencyMs: report.latencyMs, success: report.status === "ok", error: report.status === "error" ? "TYPESAFE_UNAVAILABLE" : "" });
    if (report.status !== "ok") return Response.json({ ok: false, code: "TYPESAFE_UNAVAILABLE", message: report.error ?? "TypeSafe не вернул результат." }, { status: 502 });
    return Response.json({ ok: true, model: report.model, latencyMs: report.latencyMs, verdict: report.evaluations[0].choice, confidence: report.evaluations[0].confidence });
  } catch (error) {
    return httpError(error);
  }
}
