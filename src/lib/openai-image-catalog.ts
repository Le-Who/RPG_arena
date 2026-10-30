import { HttpError } from "./http";
import type { ModelPrice } from "./model-pricing";

// Active direct Images API models, checked against the official reference on 2026-10-30.
// https://developers.openai.com/api/reference/resources/images/methods/generate
// Retired DALL-E models and gpt-image-1 deliberately remain outside this allowlist.
export const OPENAI_IMAGE_DEFAULT_MODEL = "gpt-image-2.5-flare";
export const OPENAI_IMAGE_MODEL_IDS = Object.freeze([
  OPENAI_IMAGE_DEFAULT_MODEL,
  "gpt-image-2.5-sunburst",
  "gpt-image-2",
  "gpt-image-1.5",
  "gpt-image-1-mini",
  "chatgpt-image-latest",
  "gpt-image-2.5-flare-2026-09-08",
  "gpt-image-2.5-sunburst-2026-09-08",
  "gpt-image-2-2026-04-21",
] as const);
const allowedModels = new Set<string>(OPENAI_IMAGE_MODEL_IDS);
const CHECKED_AT = "2026-10-30T00:00:00.000Z";
const SOURCE = "https://developers.openai.com/api/docs/guides/image-generation";
export type OpenAIImageModel = { id: string; name: string; generationSupported: true; price: ModelPrice };

export function assertOpenAIImageModel(model: string): void {
  if (!allowedModels.has(model)) throw new HttpError(400, "IMAGE_MODEL_INCOMPATIBLE", "Выберите поддерживаемую модель изображений OpenAI из списка.");
}

/** Public documented capabilities; listing a model does not verify an account's access to it. */
export function loadOpenAIImageModels(): { models: OpenAIImageModel[]; checkedAt: string; stale: boolean } {
  const models: OpenAIImageModel[] = OPENAI_IMAGE_MODEL_IDS.map(id => ({
    id,
    name: id,
    generationSupported: true,
    price: {
      currency: "USD",
      status: id.startsWith("gpt-image-2.5-") ? "estimate" : "unknown",
      // The guide documents both 2.5 variants at these token rates. Input-image
      // and cached-input rates do not apply to this direct text-only request.
      rates: id.startsWith("gpt-image-2.5-") ? [
        { component: "input_text", amount: 5 / 1_000_000, unit: "token" },
        { component: "output_image", amount: 30 / 1_000_000, unit: "token" },
      ] : [],
      source: SOURCE,
      checkedAt: CHECKED_AT,
      complete: false,
      conditions: ["Итоговая стоимость зависит от размера, качества и числа токенов; тариф не является ценой одной картинки.", "Доступ к модели и лимиты определяются вашим проектом OpenAI."],
    },
  }));
  return { models, checkedAt: CHECKED_AT, stale: false };
}
