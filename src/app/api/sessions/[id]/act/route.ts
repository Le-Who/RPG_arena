import { performTurn } from "@/lib/turn";
import { expectedTurn, httpError, HttpError, readJsonObject, requestKey, requiredText } from "@/lib/http";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJsonObject(req);
    if (body.custom !== undefined && typeof body.custom !== "boolean") throw new HttpError(400, "INVALID_INPUT", "custom должен быть boolean.");
    const result = await performTurn({ sessionId: id, action: requiredText(body.action, "Действие", 2000), isFree: body.custom !== false, requestId: requestKey(body.requestId), expectedTurn: expectedTurn(body.expectedTurn) });
    if (!result.ok) {
      const status = result.code === "NOT_FOUND" ? 404 : result.code === "BUSY" ? 429 : result.code === "INVALID_INPUT" ? 400 : result.code === "AI_FAILED" ? 503 : 409;
      return Response.json(result, { status, headers: result.retryAfter ? { "Retry-After": String(result.retryAfter) } : undefined });
    }
    return Response.json(result);
  } catch (error) { return httpError(error); }
}
