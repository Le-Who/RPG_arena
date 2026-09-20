import { withCampaignAccess } from "@/lib/campaign-access";
import { requireUuid } from "@/lib/http";
import { readNarrativeAttempts } from "@/lib/narrative-diagnostics";

export const dynamic = "force-dynamic";
export const GET = withCampaignAccess("owner", async (request, { params }) => {
  const before = new URL(request.url).searchParams.get("before") ?? undefined;
  if (before) requireUuid(before);
  return Response.json(await readNarrativeAttempts((await params).id, before));
});
