import { importCampaign } from "@/lib/campaign-copy";
import { PORTABLE_MAX_BYTES } from "@/lib/campaign-portable";
import { currentProfileId } from "@/lib/identity";
import { HttpError, readJsonObject, requestKey } from "@/lib/http";
import { withIdentityWork } from "@/lib/owner-work";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = withIdentityWork(async (request: Request) => {
  const body = await readJsonObject(request, PORTABLE_MAX_BYTES + 4096);
  const requestId = requestKey(body.requestId);
  if (!requestId) throw new HttpError(400, "INVALID_INPUT", "Для импорта нужен requestId.");
  const result = await importCampaign({ profileId: await currentProfileId(), requestId, document: body.document, title: body.title });
  return Response.json({ ok: true, ...result }, { status: result.replay ? 200 : 201, headers: { "Cache-Control": "private, no-store" } });
});
