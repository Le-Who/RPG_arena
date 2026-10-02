export type ImageModelChoice = { id: string; title: string; paidOnly: boolean };

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
      || seen.has(row.name)) continue;
    seen.add(row.name);
    choices.push({ id: row.name, title: typeof row.title === "string" ? row.title.slice(0, 100) : row.name, paidOnly: row.paid_only === true });
  }
  return choices;
}

/** Public catalogue endpoint, bounded so a provider error cannot exhaust the web process. */
export async function fetchPollinationsImageModels(fetchImpl: typeof fetch = fetch): Promise<ImageModelChoice[]> {
  const response = await fetchImpl("https://gen.pollinations.ai/image/models", { cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!response.ok || !response.body) throw new Error("POLLINATIONS_CATALOG_UNAVAILABLE");
  const limit = 512 * 1024;
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit) throw new Error("POLLINATIONS_CATALOG_TOO_LARGE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > limit) throw new Error("POLLINATIONS_CATALOG_TOO_LARGE");
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  const choices = parseImageModels(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  if (!choices.length) throw new Error("POLLINATIONS_CATALOG_EMPTY");
  return choices;
}
