import { httpError, readJsonObject } from "@/lib/http";
import { getNarrativeSettingsView, updateNarrativeSettings } from "@/lib/narrative-settings";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await getNarrativeSettingsView(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return httpError(error); }
}

export async function POST(request: Request) {
  try {
    const input = await readJsonObject(request, 4096);
    return Response.json(await updateNarrativeSettings(input), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return httpError(error); }
}
