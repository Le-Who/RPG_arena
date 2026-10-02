import { NextResponse } from "next/server";
import { requireCampaignAccess, withCampaignAccess } from "@/lib/campaign-access";
import { HttpError, httpError } from "@/lib/http";
import { deleteVisual, renderVisual } from "@/lib/visuals";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Отдаёт сохранённое изображение; при первом просмотре генерирует его у провайдера записи. */
async function handleGET(req: Request, { params }: { params: Promise<{ id: string; visualId: string }> }) {
  try {
    const { id, visualId } = await params;
    if (!UUID.test(visualId)) throw new HttpError(400, "INVALID_INPUT", "Некорректный идентификатор изображения.");
    const access = await requireCampaignAccess(id, "read");
    const retry = new URL(req.url).searchParams.get("retry") === "1";
    const { image, mimeType } = await renderVisual(id, visualId, { retry, allowGenerate: access.isOwner });
    return new Response(new Uint8Array(image), { headers: { "Content-Type": mimeType, "Content-Length": String(image.length), "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return httpError(error); }
}

async function handleDELETE(_: Request, { params }: { params: Promise<{ id: string; visualId: string }> }) {
  try {
    const { id, visualId } = await params;
    if (!UUID.test(visualId)) throw new HttpError(400, "INVALID_INPUT", "Некорректный идентификатор изображения.");
    await deleteVisual(id, visualId);
    return NextResponse.json({ ok: true });
  } catch (error) { return httpError(error); }
}

export const GET = withCampaignAccess("read", handleGET);
export const DELETE = withCampaignAccess("owner", handleDELETE);
