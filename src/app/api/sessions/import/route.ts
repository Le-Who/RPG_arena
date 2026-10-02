import { importCampaign } from "@/lib/campaign-copy";
import { PORTABLE_MAX_BYTES } from "@/lib/campaign-portable";
import { currentIdentity } from "@/lib/identity";
import { HttpError, readJsonObject, requestKey } from "@/lib/http";
import { withIdentityWork } from "@/lib/owner-work";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = withIdentityWork(async (request: Request) => {
  // Portable imports can expand into thousands of database rows. Do not expose
  // that bulk operation to automatically provisioned, disposable identities.
  const identity = await currentIdentity();
  if (identity.kind !== "account") throw new HttpError(403, "ACCOUNT_REQUIRED", "Импорт кампаний доступен после регистрации или входа.");
  const body = await readJsonObject(request, PORTABLE_MAX_BYTES + 4096);
  const requestId = requestKey(body.requestId);
  if (!requestId) throw new HttpError(400, "INVALID_INPUT", "Для импорта нужен requestId.");
  const result = await importCampaign({ profileId: identity.profileId, requestId, document: body.document, title: body.title });
  return Response.json({ ok: true, ...result }, { status: result.replay ? 200 : 201, headers: { "Cache-Control": "private, no-store" } });
});
