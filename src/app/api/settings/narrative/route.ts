import { httpError, readJsonObject } from "@/lib/http";
import { getNarrativeSettingsView, updateNarrativeSettings } from "@/lib/narrative-settings";
import { withIdentityWork } from "@/lib/owner-work";

export const dynamic = "force-dynamic";

async function handleGET() {
  try {
    return Response.json(await getNarrativeSettingsView(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return httpError(error); }
}

async function handlePOST(request: Request) {
  try {
    const input = await readJsonObject(request, 4096);
    return Response.json(await updateNarrativeSettings(input), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return httpError(error); }
}

export const GET = withIdentityWork(handleGET);
// SECURITY: Next.js API route handlers must be wrapped with access control middleware at the export level.
export const POST = withIdentityWork(handlePOST);
