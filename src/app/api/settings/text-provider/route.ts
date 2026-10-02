import { currentProfileId } from "@/lib/identity";
import { readJsonObject, httpError } from "@/lib/http";
import { withIdentityWork } from "@/lib/owner-work";
import { getTextProviderSettings, parseTextProviderSettings, saveTextProviderSettings } from "@/lib/text-provider-settings";

export const dynamic = "force-dynamic";

export const GET = withIdentityWork(async () => {
  try { return Response.json(await getTextProviderSettings(await currentProfileId()), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return httpError(error); }
});

export const POST = withIdentityWork(async (request: Request) => {
  try {
    const input = parseTextProviderSettings(await readJsonObject(request, 8192));
    return Response.json({ ok: true, ...await saveTextProviderSettings(await currentProfileId(), input) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return httpError(error); }
});
