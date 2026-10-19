import { HttpError } from "./http";
import { normalizePollinationsPrice, type ModelPrice } from "./model-pricing";

export type ImageModelChoice = { id: string; title: string; paidOnly: boolean; price?: ModelPrice };

/** Confirmed exclusions, versioned 2026-10-19. Modality text+image alone does not establish optional references. */
export const POLLINATIONS_GENERATION_EXCLUSIONS = [
  { ids: ["prunaai/p-image-edit", "pruna-edit", "pruna-image-edit", "p-image-edit"], reason: "reference", checkedAt: "2026-10-19", source: "https://github.com/pollinations/pollinations/blob/main/gen.pollinations.ai/src/image/models/prunaModel.ts" },
  { ids: ["recraft/recraft-v4.1-vector", "recraft-vector", "recraft-svg", "recraft-v4.1-svg", "recraft-v4.1-vector"], reason: "svg", checkedAt: "2026-10-19", source: "https://github.com/pollinations/pollinations/blob/main/shared/registry/image.ts" },
] as const;

export function pollinationsGenerationExcluded(model: string, aliases: string[] = []): boolean {
  return POLLINATIONS_GENERATION_EXCLUSIONS.some(entry => entry.ids.some(id => [model, ...aliases].some(value => value.trim().toLowerCase() === id)));
}

/** Shared by save, admission and execution so a manual canonical ID or alias cannot bypass exclusions. */
export function assertPollinationsGenerationModel(model: string): void {
  if (pollinationsGenerationExcluded(model)) throw new HttpError(400, "IMAGE_MODEL_INCOMPATIBLE", "Эта модель требует исходное изображение или выдаёт SVG. Выберите модель для создания растровой картинки с нуля.");
}

/** Optional references verified in the handler, rather than inferred from an edit label. */
export const POLLINATIONS_OPTIONAL_REFERENCE_MODELS = {
  checkedAt: "2026-10-19",
  source: "https://github.com/pollinations/pollinations/blob/main/gen.pollinations.ai/src/image/models/azureFluxKontextModel.ts",
  ids: ["black-forest-labs/flux.1-kontext-pro", "kontext"],
};

export function pollinationsGenerationSupported(model: string, inputs: string[], aliases: string[] = []): boolean {
  if (pollinationsGenerationExcluded(model, aliases) || !inputs.includes("text")) return false;
  return !inputs.includes("image") || [model, ...aliases].some(id => POLLINATIONS_OPTIONAL_REFERENCE_MODELS.ids.includes(id));
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const contains = (value: unknown, item: string): boolean => Array.isArray(value) && value.includes(item);

/** Offer only canonical, official models that accept text at the endpoint used by this app. */
export function parseImageModels(value: unknown): ImageModelChoice[] {
  if (!Array.isArray(value)) throw new Error("POLLINATIONS_CATALOG_INVALID");
  const seen = new Set<string>();
  const choices: ImageModelChoice[] = [];
  for (const row of value) {
    if (!record(row) || row.category !== "image" || row.community !== false
      || !contains(row.input_modalities, "text") || !contains(row.output_modalities, "image")
      || !contains(row.supported_endpoints, "/image/{prompt}")
      || typeof row.name !== "string" || !/^[a-z0-9][a-z0-9._:/-]{1,100}$/i.test(row.name)
      || seen.has(row.name) || pollinationsGenerationExcluded(row.name, Array.isArray(row.aliases) ? row.aliases.filter((v): v is string => typeof v === "string") : [])) continue;
    seen.add(row.name);
    choices.push({ id: row.name, title: typeof row.title === "string" ? row.title.slice(0, 100) : row.name, paidOnly: row.paid_only === true,
      ...(row.pricing ? { price: normalizePollinationsPrice(row, "image") } : {}) });
  }
  return choices;
}

/** Public catalogue endpoint, bounded so a provider error cannot exhaust the web process. */
export async function fetchPollinationsImageModels(fetchImpl: typeof fetch = fetch): Promise<ImageModelChoice[]> {
  const signal = AbortSignal.timeout(8000);
  const response = await fetchImpl("https://gen.pollinations.ai/image/models", { cache: "no-store", signal });
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new Error("POLLINATIONS_CATALOG_UNAVAILABLE");
  }
  const limit = 512 * 1024;
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit) {
    void response.body.cancel().catch(() => {});
    throw new Error("POLLINATIONS_CATALOG_TOO_LARGE");
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error("POLLINATIONS_CATALOG_UNAVAILABLE");
      const part = await reader.read();
      if (signal.aborted) throw new Error("POLLINATIONS_CATALOG_UNAVAILABLE");
      if (part.done) break;
      total += part.value.byteLength;
      if (total > limit) throw new Error("POLLINATIONS_CATALOG_TOO_LARGE");
      chunks.push(part.value);
    }
  } finally { signal.removeEventListener("abort", cancel); cancel(); reader.releaseLock(); }
  const bytes = new Uint8Array(total); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  const choices = parseImageModels(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  if (!choices.length) throw new Error("POLLINATIONS_CATALOG_EMPTY");
  return choices;
}
