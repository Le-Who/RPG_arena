import type { TextProvider } from "./text-provider";

type CatalogProvider = Exclude<TextProvider, "gemini">;
export type TextModelCatalogEntry = { id: string; name: string; structuredOutput: boolean; streaming: boolean };
const ENDPOINTS: Record<CatalogProvider, string> = {
  openrouter: "https://openrouter.ai/api/v1/models",
  pollinations: "https://gen.pollinations.ai/text/models",
};
const cache = new Map<CatalogProvider, { expires: number; models: TextModelCatalogEntry[] }>();
const pending = new Map<CatalogProvider, Promise<TextModelCatalogEntry[]>>();
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const boundedString = (value: unknown, max: number) => typeof value === "string" && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : "";

/** False means the public catalog has not confirmed this capability, never a denial. */
export function parseTextModelCatalog(provider: CatalogProvider, payload: unknown): TextModelCatalogEntry[] {
  const rows = provider === "openrouter" ? record(payload).data : payload;
  if (!Array.isArray(rows) || rows.length > 2000) throw new Error("CATALOG_UNAVAILABLE");
  const models: TextModelCatalogEntry[] = [], seen = new Set<string>();
  for (const row of rows) {
    const source = record(row), architecture = provider === "openrouter" ? record(source.architecture) : source;
    if (!strings(architecture.input_modalities).includes("text") || !strings(architecture.output_modalities).includes("text")) continue;
    if (provider === "pollinations" && Array.isArray(source.supported_endpoints) && !strings(source.supported_endpoints).includes("/v1/chat/completions")) continue;
    const id = boundedString(provider === "openrouter" ? source.id : source.name, 256);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const parameters = strings(source.supported_parameters);
    models.push({ id, name: boundedString(provider === "openrouter" ? source.name : source.title, 256) || id,
      // response_format alone can mean JSON object only, so it does not establish schema support.
      structuredOutput: parameters.includes("structured_outputs") || parameters.includes("json_schema"),
      streaming: provider === "openrouter" || parameters.includes("stream"),
    });
  }
  return models;
}

async function fetchCatalog(provider: CatalogProvider): Promise<TextModelCatalogEntry[]> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abort = () => { void reader?.cancel().catch(() => {}); };
  controller.signal.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(ENDPOINTS[provider], { signal: controller.signal, redirect: "error", cache: "no-store", headers: { Accept: "application/json" } });
    if (!response.ok || !response.body) { void response.body?.cancel().catch(() => {}); throw new Error("CATALOG_UNAVAILABLE"); }
    reader = response.body.getReader();
    let bytes = 0, body = ""; const decoder = new TextDecoder();
    while (true) {
      controller.signal.throwIfAborted();
      const { done, value } = await reader.read();
      controller.signal.throwIfAborted();
      bytes += value?.byteLength ?? 0;
      if (bytes > 3_000_000) throw new Error("CATALOG_UNAVAILABLE");
      body += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (done) break;
    }
    return parseTextModelCatalog(provider, JSON.parse(body));
  } catch { throw new Error("CATALOG_UNAVAILABLE"); }
  finally {
    clearTimeout(timer); controller.signal.removeEventListener("abort", abort);
    void reader?.cancel().catch(() => {}); reader?.releaseLock();
  }
}

/** Public metadata only: cache is provider-scoped and never depends on account keys. */
export async function loadTextModelCatalog(provider: CatalogProvider): Promise<TextModelCatalogEntry[]> {
  if (provider !== "openrouter" && provider !== "pollinations") throw new Error("CATALOG_UNAVAILABLE");
  const stored = cache.get(provider);
  if (stored && stored.expires > Date.now()) return stored.models.map(model => ({ ...model }));
  let work = pending.get(provider);
  if (!work) {
    work = fetchCatalog(provider).then(models => { cache.set(provider, { expires: Date.now() + 60_000, models }); return models; }).finally(() => { pending.delete(provider); });
    pending.set(provider, work);
  }
  return (await work).map(model => ({ ...model }));
}
