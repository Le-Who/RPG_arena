import { withCampaignAccess } from "@/lib/campaign-access";
import { requireUuid } from "@/lib/http";
import { readNarrativeAttempts } from "@/lib/narrative-diagnostics";
import { requireAdmin } from "@/lib/admin-access";
import { httpError } from "@/lib/http";

export const dynamic = "force-dynamic";
const read = withCampaignAccess("owner", async (request, { params }) => {
  const before = new URL(request.url).searchParams.get("before") ?? undefined;
  if (before) requireUuid(before);
  return Response.json(await readNarrativeAttempts((await params).id, before));
});
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try { await requireAdmin(); return await read(request, context); }
  catch (error) { return httpError(error); }
}
