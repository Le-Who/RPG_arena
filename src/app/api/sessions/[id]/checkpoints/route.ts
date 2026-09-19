import { randomUUID } from "node:crypto";
import { createCheckpoint, listCheckpoints } from "@/lib/checkpoints";
import { CHECKPOINT_LIMIT } from "@/lib/checkpoint-types";
import { expectedTurn, httpError, readJsonObject, requestKey, requiredText, requireUuid } from "@/lib/http";
export const dynamic = "force-dynamic";
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try { const { id } = await params; return Response.json({ checkpoints: await listCheckpoints(requireUuid(id)), limit: CHECKPOINT_LIMIT }); }
  catch (error) { return httpError(error); }
}
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try { const { id } = await params; const body = await readJsonObject(req); const result = await createCheckpoint({ sessionId: requireUuid(id), title: requiredText(body.title, "Название точки"), expectedTurn: expectedTurn(body.expectedTurn), requestId: requestKey(body.requestId) ?? randomUUID() }); return Response.json({ ok: true, ...result }, { status: result.replay ? 200 : 201 }); }
  catch (error) { return httpError(error); }
}
