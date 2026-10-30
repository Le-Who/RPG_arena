import { currentProfileId } from "@/lib/identity";
import { withIdentityWork } from "@/lib/owner-work";
import { HttpError, httpError } from "@/lib/http";
import { loadPollinationsModels } from "@/lib/pollinations-model-catalog";
import { loadOpenRouterImageModels } from "@/lib/openrouter-image-catalog";
import { loadOpenAIImageModels } from "@/lib/openai-image-catalog";

export const dynamic = "force-dynamic";

export const GET = withIdentityWork(async (request: Request) => {
  try {
    const query = new URL(request.url).searchParams, provider = query.get("provider");
    if (provider !== "pollinations" && provider !== "openrouter" && provider !== "openai") throw new HttpError(400, "INVALID_INPUT", "Укажите Pollinations, OpenRouter или OpenAI для иллюстраций.");
    const owner = await currentProfileId(), refresh = query.get("refresh") === "1";
    const catalog = provider === "pollinations" ? await loadPollinationsModels(owner, "image", refresh)
      : provider === "openai" ? loadOpenAIImageModels()
      : await loadOpenRouterImageModels({ refresh, ...(query.has("model") ? { model: query.get("model")! } : {}), ...(query.has("endpoint") ? { endpoint: query.get("endpoint")! } : {}) });
    // Personal Pollinations metadata may contain private model names; discovery can outlive a session.
    if (await currentProfileId() !== owner) throw new HttpError(401, "IDENTITY_CHANGED", "Профиль изменился. Обновите страницу.");
    return Response.json(catalog, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return httpError(error); }
});
