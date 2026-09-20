import { HttpError, httpError, readJsonObject } from "@/lib/http";
import { getTypeSafeSettingsView, updateTypeSafeSettings } from "@/lib/typesafe-settings";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await getTypeSafeSettingsView());
  } catch (error) {
    return httpError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJsonObject(request, 4096);
    const update: { key?: string; clearKey?: boolean; pilotEnabled?: boolean } = {};
    if (body.key !== undefined) {
      if (typeof body.key !== "string" || body.key.trim().length < 12 || body.key.trim().length > 500) {
        throw new HttpError(400, "INVALID_KEY", "Ключ TypeSafe должен содержать от 12 до 500 символов.");
      }
      update.key = body.key;
    }
    if (body.clearKey !== undefined) {
      if (typeof body.clearKey !== "boolean") throw new HttpError(400, "INVALID_INPUT", "Некорректная команда удаления ключа.");
      update.clearKey = body.clearKey;
    }
    if (body.pilotEnabled !== undefined) {
      if (typeof body.pilotEnabled !== "boolean") throw new HttpError(400, "INVALID_INPUT", "Некорректное состояние пилота.");
      update.pilotEnabled = body.pilotEnabled;
    }
    return Response.json({ ok: true, ...(await updateTypeSafeSettings(update)) });
  } catch (error) {
    return httpError(error);
  }
}
