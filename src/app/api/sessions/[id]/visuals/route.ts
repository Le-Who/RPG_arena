import { NextResponse } from "next/server";
import { withCampaignAccess } from "@/lib/campaign-access";
import { HttpError, httpError, readJsonObject } from "@/lib/http";
import { createVisual, listVisuals } from "@/lib/visuals";
import type { VisualKind } from "@/db/schema";

export const dynamic = "force-dynamic";

/** VIS-1: галерея иллюстраций кампании и паспорта внешности (без байтов изображений). */
async function handleGET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return NextResponse.json(await listVisuals(id));
  } catch (error) { return httpError(error); }
}

/** Ручной запрос иллюстрации: scene (ход), location (место) или portrait (hero | npc:<key>). */
async function handlePOST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJsonObject(req);
    const kind = body.kind as VisualKind;
    if (!["scene", "portrait", "location"].includes(kind)) throw new HttpError(400, "INVALID_INPUT", "Укажите тип иллюстрации: scene, portrait или location.");
    const subject = typeof body.subject === "string" ? body.subject.slice(0, 120) : null;
    const turnNumber = Number.isInteger(body.turnNumber) ? Number(body.turnNumber) : null;
    const visual = await createVisual(id, { kind, subject, turnNumber });
    return NextResponse.json({ visual }, { status: 201 });
  } catch (error) { return httpError(error); }
}

export const GET = withCampaignAccess("read", handleGET);
export const POST = withCampaignAccess("owner", handlePOST);
