import { withCampaignAccess } from "@/lib/campaign-access";
import { deleteCheckpoint } from "@/lib/checkpoints";
import { httpError, requireUuid } from "@/lib/http";
export const dynamic = "force-dynamic";
async function handleDELETE(_: Request, { params }: { params: Promise<{ id: string; checkpointId: string }> }) {
  try { const { id, checkpointId } = await params; await deleteCheckpoint(requireUuid(id), requireUuid(checkpointId)); return Response.json({ ok: true }); }
  catch (error) { return httpError(error); }
}

export const DELETE = withCampaignAccess("owner", handleDELETE);
