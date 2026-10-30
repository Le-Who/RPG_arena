import { withCampaignAccess } from "@/lib/campaign-access";
import { getTurnRequest } from "@/lib/turn-admission";
import { httpError, requireUuid, requestKey } from "@/lib/http";
import type { TurnRequestStatus } from "@/lib/turn-contract";
export const dynamic = "force-dynamic";
async function handleGET(_: Request, { params }: { params: Promise<{ id: string; requestId: string }> }) {
  try {
    const { id, requestId } = await params;
    const key = requestKey(requestId)!;
    const result = await getTurnRequest(requireUuid(id), key);
    const status: TurnRequestStatus = result ?? { requestId: key, status: "not_accepted" };
    return Response.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return httpError(error); }
}

export const GET = withCampaignAccess("owner", handleGET);
