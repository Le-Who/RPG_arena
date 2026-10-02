import { httpError, readJsonObject } from "@/lib/http";
import { getNarrativeSettingsView, updateNarrativeSettings } from "@/lib/narrative-settings";
import { withIdentityWork, withCurrentIdentityWork } from "@/lib/owner-work";

export const dynamic = "force-dynamic";

async function handleGET() {
  try {
    return Response.json(await getNarrativeSettingsView(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return httpError(error); }
}

async function handlePOST(request: Request) {
  try {
    const input = await readJsonObject(request, 4096);
    return await withCurrentIdentityWork(async () => Response.json(await updateNarrativeSettings(input), { headers: { "Cache-Control": "no-store" } }));
  } catch (error) { return httpError(error); }
}
export const GET = withIdentityWork(handleGET);
export const POST = handlePOST;
