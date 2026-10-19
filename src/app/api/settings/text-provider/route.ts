import { currentIdentity, currentProfileId } from "@/lib/identity";
import { readJsonObject, httpError } from "@/lib/http";
import { withIdentityWork } from "@/lib/owner-work";
import { getTextProviderSettings, parseTextProviderSettings, saveTextProviderSettings } from "@/lib/text-provider-settings";

export const dynamic = "force-dynamic";

export const GET = withIdentityWork(async () => {
  try {
    const view = await getTextProviderSettings(await currentProfileId());
    await currentIdentity();
    return Response.json(view, { headers: { "Cache-Control": "no-store" } });
  }
  catch (error) { return httpError(error); }
});

export const POST = withIdentityWork(async (request: Request) => {
  try {
    const input = parseTextProviderSettings(await readJsonObject(request, 8192));
    const view = await saveTextProviderSettings(await currentProfileId(), input);
    await currentIdentity();
    return Response.json({ ok: true, ...view }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return httpError(error); }
});
