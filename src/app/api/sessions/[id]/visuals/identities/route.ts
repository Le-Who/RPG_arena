import { NextResponse } from "next/server";
import { withCampaignAccess } from "@/lib/campaign-access";
import { HttpError, httpError, readJsonObject } from "@/lib/http";
import { updateIdentity } from "@/lib/visuals";

export const dynamic = "force-dynamic";

/** VIS-2: правка паспорта внешности, выбор эталонного изображения, новый seed. */
async function handlePATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readJsonObject(req);
    if (typeof body.subjectKey !== "string" || !body.subjectKey) throw new HttpError(400, "INVALID_INPUT", "Укажите subjectKey.");
    const identity = await updateIdentity(id, body.subjectKey.slice(0, 120), {
      ...(typeof body.passport === "string" ? { passport: body.passport } : {}),
      ...(body.referenceVisualId === null || typeof body.referenceVisualId === "string" ? { referenceVisualId: body.referenceVisualId as string | null } : {}),
      ...(body.reseed === true ? { reseed: true } : {}),
    });
    return NextResponse.json({ identity });
  } catch (error) { return httpError(error); }
}

export const PATCH = withCampaignAccess("owner", handlePATCH);
