import { currentProfileId } from "@/lib/identity";
import { withIdentityWork } from "@/lib/owner-work";
import { HttpError, httpError } from "@/lib/http";
import { loadPollinationsModels } from "@/lib/pollinations-model-catalog";
export const dynamic = "force-dynamic";
export const GET = withIdentityWork(async (request: Request) => {
  try {
    const query = new URL(request.url).searchParams, kind = query.get("kind");
    if (kind !== "text" && kind !== "image") throw new HttpError(400, "INVALID_INPUT", "Укажите текстовый каталог или каталог изображений.");
    const owner = await currentProfileId();
    const catalog = await loadPollinationsModels(owner, kind, query.get("refresh") === "1");
    // A personal catalog may contain private model names; discovery can outlive its session.
    if (await currentProfileId() !== owner) throw new HttpError(401, "IDENTITY_CHANGED", "Профиль изменился. Обновите страницу.");
    return Response.json(catalog, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return httpError(error); }
});
