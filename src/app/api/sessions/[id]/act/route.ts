import { withCampaignAccess } from "@/lib/campaign-access";
import { performTurn } from "@/lib/turn";
import { getAIConfig } from "@/lib/ai-settings";
import { after } from "next/server";
import { turnHttpResponse } from "@/lib/turn-http";
import { normalizeItemIds } from "@/lib/item-bindings";
import { expectedTurn, httpError, HttpError, readJsonObject, requestKey, requiredText } from "@/lib/http";
import { withCurrentIdentityWork } from "@/lib/owner-work";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
async function handlePOST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJsonObject(req);
    if (body.custom !== undefined && typeof body.custom !== "boolean") throw new HttpError(400, "INVALID_INPUT", "custom должен быть boolean.");
    const input = { sessionId: id, action: requiredText(body.action, "Действие", 2000), isFree: body.custom !== false, requestId: requestKey(body.requestId), expectedTurn: expectedTurn(body.expectedTurn), itemIds: normalizeItemIds(body.itemIds) };
    // Foreground AI always belongs to the player making this request. Public
    // campaigns must first be copied into that player's private workspace.
    const playerConfig = await getAIConfig();
    return turnHttpResponse(req.headers.get("accept")?.includes("application/x-ndjson") ?? false, runtime => withCurrentIdentityWork(() => performTurn({ ...input, expectedOwnerId: playerConfig.ownerId }, { ...runtime, loadAIConfig: async () => playerConfig })), after);
  } catch (error) { return httpError(error); }
}

export const POST = withCampaignAccess("owner", handlePOST);
