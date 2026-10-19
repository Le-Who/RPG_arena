import { currentIdentity, currentProfileId } from "@/lib/identity";
import { withIdentityWork } from "@/lib/owner-work";
import { httpError, readJsonObject } from "@/lib/http";
import { getProviderConnections, saveProviderConnection } from "@/lib/text-provider-settings";

export const dynamic = "force-dynamic";
export const GET = withIdentityWork(async () => {
  try {
    const view = await getProviderConnections(await currentProfileId());
    await currentIdentity();
    return Response.json(view, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return httpError(error); }
});
export const POST = withIdentityWork(async (request: Request) => {
  try {
    const view = await saveProviderConnection(await currentProfileId(), await readJsonObject(request, 8192));
    await currentIdentity();
    return Response.json(view, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return httpError(error); }
});
