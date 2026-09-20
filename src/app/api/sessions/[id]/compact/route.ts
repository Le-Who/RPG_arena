import { withCampaignAccess } from "@/lib/campaign-access";
import { after } from "next/server";
import { compactSession } from "@/lib/compaction";
import { runMemoryCycle } from "@/lib/background";
import { httpError, requireUuid } from "@/lib/http";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
async function handlePOST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await compactSession(requireUuid(id));
    if (result.created) after(async () => { await runMemoryCycle({ sessionId: id, source: "after" }).catch(() => {}); });
    return Response.json(result);
  } catch (error) { return httpError(error); }
}

export const POST = withCampaignAccess("owner", handlePOST);
