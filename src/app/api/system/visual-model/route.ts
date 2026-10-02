import { withAdminAccess, requireAdmin } from "@/lib/admin-access";
import { readVisualConfig, saveVisualModel } from "@/lib/visual-settings";
import { fetchPollinationsImageModels } from "@/lib/visual-models";
import { HttpError, httpError, readJsonObject } from "@/lib/http";
import { assertAuthOrigin } from "@/lib/auth-policy";

export const dynamic = "force-dynamic";

async function handleGET() {
  try {
    const config = await readVisualConfig();
    let models: Awaited<ReturnType<typeof fetchPollinationsImageModels>> = [];
    let catalogError: string | null = null;
    try { models = await fetchPollinationsImageModels(); }
    catch { catalogError = "Каталог Pollinations сейчас недоступен. Выбранная модель сохранена."; }
    return Response.json({ model: config.model, keyConfigured: config.authenticated, models, catalogError }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return httpError(error); }
}

async function handlePATCH(req: Request) {
  try {
    const admin = await requireAdmin();
    assertAuthOrigin(req);
    const body = await readJsonObject(req, 2048);
    const model = body.model;
    if (typeof model !== "string" || !/^[a-z0-9][a-z0-9._:/-]{1,100}$/i.test(model)) throw new HttpError(400, "INVALID_MODEL", "Выберите модель из каталога Pollinations.");
    let models: Awaited<ReturnType<typeof fetchPollinationsImageModels>>;
    try { models = await fetchPollinationsImageModels(); }
    catch { throw new HttpError(503, "MODEL_CATALOG_UNAVAILABLE", "Не удалось проверить модель по каталогу Pollinations. Повторите позже."); }
    if (!models.some((choice) => choice.id === model)) throw new HttpError(400, "INVALID_MODEL", "Эта модель недоступна для генерации изображений через выбранный API.");
    await saveVisualModel(model, admin.account!.id);
    return Response.json({ ok: true, model }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return httpError(error); }
}

export const GET = withAdminAccess(handleGET);
export const PATCH = withAdminAccess(handlePATCH);
