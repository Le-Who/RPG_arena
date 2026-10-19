import { HttpError } from "./http";
import { normalizeOpenRouterImagePrice, type ModelPrice } from "./model-pricing";

export type OpenRouterImageModel = { id: string; name: string; endpoint?: string; price?: ModelPrice; generationSupported: boolean; supportedParameters?: Record<string, unknown> };
export type OpenRouterImageEndpoint = { endpoint: string; price: ModelPrice; supportedParameters: Record<string, unknown> };
const ROOT = "https://openrouter.ai/api/v1/images/models";
const TTL = 15 * 60_000, MAX_STALE = 24 * 3600_000;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const validModel = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9][a-z0-9._:@+-]{0,149}$/i.test(value);
const validEndpoint = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9][a-z0-9._:/@+-]{0,149}$/i.test(value);
const unavailable = () => new HttpError(502, "OPENROUTER_IMAGE_CATALOG_UNAVAILABLE", "Не удалось проверить каталог изображений OpenRouter. Повторите обновление; сохранённая модель не изменена.");
const incompatible = () => new HttpError(400, "IMAGE_MODEL_INCOMPATIBLE", "Маршрут модели не подтверждён для создания растровой картинки без исходного изображения. Выберите другой маршрут.");
type Cached<T> = { value: T; checkedAt: number };
let listCache: Cached<OpenRouterImageModel[]> | undefined;
let listPending: Promise<Cached<OpenRouterImageModel[]>> | undefined;
const endpointCache = new Map<string, Cached<OpenRouterImageEndpoint[]>>();
const endpointPending = new Map<string, Promise<Cached<OpenRouterImageEndpoint[]>>>();

/** Public fixed-origin metadata only. Hard deadline covers transports that ignore AbortSignal. */
async function json(url: string): Promise<unknown> {
  const controller = new AbortController(); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); void reader?.cancel().catch(() => {}); reject(unavailable()); }, 8000); });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetch(url, { cache: "no-store", redirect: "error", signal: controller.signal, headers: { Accept: "application/json" } });
      if (controller.signal.aborted || !response.ok || !response.body || Number(response.headers.get("content-length")) > 3_000_000) { void response.body?.cancel().catch(() => {}); throw unavailable(); }
      reader = response.body.getReader(); let size = 0, body = ""; const decoder = new TextDecoder("utf-8", { fatal: true });
      while (true) {
        controller.signal.throwIfAborted(); const part = await reader.read(); controller.signal.throwIfAborted();
        size += part.value?.byteLength ?? 0; if (size > 3_000_000) throw unavailable();
        body += part.done ? decoder.decode() : decoder.decode(part.value, { stream: true });
        if (part.done) return JSON.parse(body) as unknown;
      }
    })()]);
  } catch { throw unavailable(); }
  finally { clearTimeout(timer); void reader?.cancel().catch(() => {}); reader?.releaseLock(); }
}

function eligibleParameters(value: unknown): boolean {
  const parameters = record(value), refs = record(parameters.input_references), formats = record(parameters.output_format);
  // Missing reference capability is unknown. A documented range with min=0 confirms generation.
  if (refs.type !== "range" || refs.min !== 0 || typeof refs.max !== "number" || refs.max < 0) return false;
  // An absent format knob uses the Image API's raster default. An explicit SVG-only enum cannot.
  return parameters.output_format === undefined || (formats.type === "enum" && strings(formats.values).some(format => ["png", "jpeg", "webp"].includes(format)));
}

export function parseOpenRouterImageEndpoints(model: string, payload: unknown, checkedAt = new Date().toISOString()): OpenRouterImageEndpoint[] {
  const source = record(payload), rows = source.endpoints;
  if (source.id !== model || !Array.isArray(rows) || rows.length > 200) throw unavailable();
  const result: OpenRouterImageEndpoint[] = [], seen = new Set<string>(), duplicate = new Set<string>();
  for (const row of rows) {
    const value = record(row), endpoint = value.provider_tag;
    if (!validEndpoint(endpoint)) continue;
    if (seen.has(endpoint)) { duplicate.add(endpoint); continue; }
    seen.add(endpoint);
    if (!eligibleParameters(value.supported_parameters)) continue;
    result.push({ endpoint, supportedParameters: structuredClone(record(value.supported_parameters)), price: normalizeOpenRouterImagePrice(value.pricing, `${ROOT}/${model}/endpoints`, checkedAt) });
  }
  // A provider tag that pins multiple distinct endpoints cannot promise one endpoint's price/capability.
  return result.filter(endpoint => !duplicate.has(endpoint.endpoint));
}

export function parseOpenRouterImageModels(payload: unknown): OpenRouterImageModel[] {
  const rows = record(payload).data;
  if (!Array.isArray(rows) || rows.length > 2000) throw unavailable();
  const result: OpenRouterImageModel[] = [], seen = new Set<string>();
  for (const row of rows) {
    const value = record(row), architecture = record(value.architecture), id = value.id;
    if (!validModel(id) || seen.has(id) || !strings(architecture.input_modalities).includes("text") || !strings(architecture.output_modalities).includes("image")) continue;
    // Aggregate metadata can rule a model out without querying every route. It
    // cannot confirm the endpoint that will serve and bill an accepted request.
    const parameters = record(value.supported_parameters), refs = record(parameters.input_references), formats = record(parameters.output_format);
    if (refs.type === "range" && typeof refs.min === "number" && Number.isFinite(refs.min) && refs.min > 0) continue;
    const outputs = strings(formats.values);
    if (formats.type === "enum" && outputs.length && !outputs.some(format => ["png", "jpeg", "webp"].includes(format))) continue;
    seen.add(id);
    result.push({ id, name: typeof value.name === "string" ? value.name.slice(0, 200) : id, generationSupported: false });
  }
  return result;
}

async function loadList(refresh: boolean): Promise<Cached<OpenRouterImageModel[]>> {
  if (!refresh && listCache && listCache.checkedAt + TTL > Date.now()) return listCache;
  if (!listPending) listPending = json(ROOT).then(payload => {
    const entry = { value: parseOpenRouterImageModels(payload), checkedAt: Date.now() }; listCache = entry; return entry;
  }).finally(() => { listPending = undefined; });
  return listPending;
}

async function loadEndpoints(model: string, refresh = false): Promise<Cached<OpenRouterImageEndpoint[]>> {
  if (!validModel(model)) throw incompatible();
  const stored = endpointCache.get(model);
  if (!refresh && stored && stored.checkedAt + TTL > Date.now()) return stored;
  let work = endpointPending.get(model);
  if (!work) {
    work = json(`${ROOT}/${model}/endpoints`).then(payload => {
      const checkedAt = Date.now(), value = parseOpenRouterImageEndpoints(model, payload, new Date(checkedAt).toISOString());
      const entry = { value, checkedAt }; endpointCache.delete(model); endpointCache.set(model, entry);
      if (endpointCache.size > 128) endpointCache.delete(endpointCache.keys().next().value!);
      return entry;
    }).finally(() => { endpointPending.delete(model); });
    endpointPending.set(model, work);
  }
  return work;
}

/** At most three defaults and one selected model, in pairs; full search metadata needs no endpoint fanout. */
export async function loadOpenRouterImageModels(options: { model?: string; endpoint?: string; refresh?: boolean } = {}) {
  if (options.model !== undefined && !validModel(options.model)) throw new HttpError(400, "INVALID_INPUT", "Некорректный ID модели OpenRouter.");
  if (options.endpoint !== undefined && (!options.model || !validEndpoint(options.endpoint))) throw new HttpError(400, "INVALID_INPUT", "Некорректный маршрут модели OpenRouter.");
  let list: Cached<OpenRouterImageModel[]>, stale = false;
  try { list = await loadList(options.refresh === true); }
  catch { if (!listCache || listCache.checkedAt + MAX_STALE <= Date.now()) throw unavailable(); list = listCache; stale = true; }
  const models = structuredClone(list.value);
  const preferred = ["bytedance-seed/seedream-4.5", "black-forest-labs/flux.2-pro", "black-forest-labs/flux.2-klein-4b"];
  const discovery = [...preferred.filter(id => models.some(model => model.id === id)), ...models.map(model => model.id)].filter((id, index, all) => all.indexOf(id) === index).slice(0, 3);
  if (options.model && !discovery.includes(options.model)) discovery.push(options.model);
  if (options.model && !models.some(model => model.id === options.model)) models.push({ id: options.model, name: options.model, generationSupported: false });
  for (let offset = 0; offset < discovery.length; offset += 2) await Promise.all(discovery.slice(offset, offset + 2).map(async id => {
    let entry: Cached<OpenRouterImageEndpoint[]>;
    try { entry = await loadEndpoints(id, options.refresh === true); }
    catch {
      const stored = endpointCache.get(id); stale = true;
      if (!stored || stored.checkedAt + MAX_STALE <= Date.now()) return;
      entry = stored;
    }
    const endpoint = options.model === id && options.endpoint ? entry.value.find(endpoint => endpoint.endpoint === options.endpoint) : entry.value[0];
    const model = models.find(model => model.id === id);
    if (model && endpoint) Object.assign(model, { endpoint: endpoint.endpoint, price: { ...structuredClone(endpoint.price), stale: entry.checkedAt + TTL <= Date.now() }, supportedParameters: endpoint.supportedParameters, generationSupported: true });
  }));
  return { models, checkedAt: new Date(list.checkedAt).toISOString(), stale };
}

export async function resolveOpenRouterImageEndpoint(model: string, endpoint: string): Promise<OpenRouterImageEndpoint> {
  if (!validEndpoint(endpoint)) throw incompatible();
  const found = (await loadEndpoints(model)).value.find(value => value.endpoint === endpoint);
  if (!found) throw incompatible();
  return structuredClone(found);
}

export async function assertOpenRouterImageEndpoint(model: string, endpoint: string): Promise<void> {
  await resolveOpenRouterImageEndpoint(model, endpoint);
}
