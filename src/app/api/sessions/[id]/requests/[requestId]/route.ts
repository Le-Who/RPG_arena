import { getTurnRequest } from "@/lib/turn-admission";
import { httpError, HttpError, requireUuid, requestKey } from "@/lib/http";
export const dynamic = "force-dynamic";
export async function GET(_: Request, { params }: { params: Promise<{ id: string; requestId: string }> }) {
  try {
    const { id, requestId } = await params;
    const result = await getTurnRequest(requireUuid(id), requestKey(requestId)!);
    if (!result) throw new HttpError(404, "NOT_FOUND", "Запрос ещё не принят сервером.");
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return httpError(error); }
}
