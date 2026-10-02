import { HttpError, httpError, readJsonObject } from "@/lib/http";
import { parseVitalBatch } from "@/lib/performance-report";
import { recordVitalSamples, telemetryEnabled } from "@/lib/performance-store";

export const dynamic = "force-dynamic";

/** PERF-1/PERF-4: anonymous field measurements. Same-origin is enforced by the proxy; no identity is stored. */
export async function POST(req: Request) {
  if (!telemetryEnabled()) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  try {
    const body = await readJsonObject(req, 8192);
    if (!Array.isArray(body.samples)) throw new HttpError(400, "INVALID_INPUT", "Ожидается список замеров.");
    const { samples } = parseVitalBatch(body);
    if (samples.length) await recordVitalSamples(samples);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return httpError(error); }
}
