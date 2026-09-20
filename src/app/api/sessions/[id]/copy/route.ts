import { withCampaignAccess } from "@/lib/campaign-access";
import { copyCampaign } from "@/lib/campaign-copy";
import { currentProfileId } from "@/lib/identity";
import { HttpError, readJsonObject, requestKey } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = withCampaignAccess("read", async (request, { params }) => {
  const { id } = await params;
  const body = await readJsonObject(request);
  const requestId = requestKey(body.requestId);
  if (!requestId) throw new HttpError(400, "INVALID_INPUT", "Для копирования нужен requestId.");
  const result = await copyCampaign({ sessionId: id, profileId: await currentProfileId(), requestId });
  return Response.json({ ok: true, ...result }, { status: result.replay ? 200 : 201 });
});
