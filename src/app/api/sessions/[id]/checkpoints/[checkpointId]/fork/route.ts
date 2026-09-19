import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { forkCheckpoint } from "@/lib/checkpoints";
import { runMemoryCycle } from "@/lib/background";
import { httpError, readJsonObject, requestKey, requiredText, requireUuid } from "@/lib/http";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function POST(req: Request, { params }: { params: Promise<{ id: string; checkpointId: string }> }) {
  try {
    const { id, checkpointId } = await params; const body = await readJsonObject(req);
    const result = await forkCheckpoint({ sessionId: requireUuid(id), checkpointId: requireUuid(checkpointId), title: requiredText(body.title, "Название ветки"), requestId: requestKey(body.requestId) ?? randomUUID() });
    if (!result.replay) after(async () => { await runMemoryCycle({ sessionId: result.session.id, source: "after" }).catch(() => {}); });
    return Response.json({ ok: true, ...result }, { status: result.replay ? 200 : 201 });
  } catch (error) { return httpError(error); }
}
