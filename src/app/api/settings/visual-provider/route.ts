import { currentIdentity, currentProfileId } from "@/lib/identity";
import { withIdentityWork } from "@/lib/owner-work";
import { httpError, readJsonObject } from "@/lib/http";
import { getVisualPreferences, saveVisualPreferences } from "@/lib/visual-settings";
export const dynamic = "force-dynamic";
export const GET = withIdentityWork(async () => {
  try {
    const view = await getVisualPreferences(await currentProfileId());
    await currentIdentity();
    return Response.json(view, { headers: { "Cache-Control": "private, no-store" } });
  }
  catch (error) { return httpError(error); }
});
export const POST = withIdentityWork(async (request: Request) => {
  try {
    const view = await saveVisualPreferences(await currentProfileId(), await readJsonObject(request, 2048));
    await currentIdentity();
    return Response.json(view, { headers: { "Cache-Control": "private, no-store" } });
  }
  catch (error) { return httpError(error); }
});
