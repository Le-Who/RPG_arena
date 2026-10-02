import { withCampaignAccess } from "@/lib/campaign-access";
import { requireUuid } from "@/lib/http";
import { readNarrativeAttempts } from "@/lib/narrative-diagnostics";
import { withAdminAccess } from "@/lib/admin-access";

export const dynamic = "force-dynamic";
const read = withCampaignAccess("owner", async (request, { params }) => {
  const before = new URL(request.url).searchParams.get("before") ?? undefined;
  if (before) requireUuid(before);
  return Response.json(await readNarrativeAttempts((await params).id, before));
});
export const GET = withAdminAccess(read);
