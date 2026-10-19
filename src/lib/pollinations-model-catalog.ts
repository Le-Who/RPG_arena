import { createHash } from "node:crypto";
import { db } from "@/db";
import { aiSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { HttpError } from "./http";
import { openSecret, secretContext } from "./secret-vault";
import { normalizePollinationsPrice, type ModelPrice } from "./model-pricing";
import { pollinationsGenerationExcluded, pollinationsGenerationSupported } from "./visual-models";

export type PollinationsModel = { id: string; name: string; structuredOutput: boolean; streaming: boolean; paidOnly: boolean; price?: ModelPrice; generationSupported?: boolean; community?: boolean };
type Kind = "text" | "image";
type Entry = { models: (PollinationsModel & { aliases: string[] })[]; checkedAt: number };
const cache = new Map<string, Entry>();
const pending = new Map<string, Promise<Entry>>();
const TTL = 15 * 60_000, MAX_STALE = 24 * 3600_000;
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length <= 200) : [];
const unavailable = () => new HttpError(502, "POLLINATIONS_CATALOG_UNAVAILABLE", "Не удалось загрузить каталог или проверить доступ аккаунта Pollinations. Повторите обновление либо введите ID модели вручную.");

/** Bounded transport, including fetches/readers that do not honor AbortSignal themselves. */
async function json(url: string, apiKey?: string): Promise<unknown> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); void reader?.cancel().catch(() => {}); reject(unavailable()); }, 8000); });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetch(url, { signal: controller.signal, redirect: "error", cache: "no-store", headers: { Accept: "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) } });
      if (controller.signal.aborted || !response.ok || !response.body || Number(response.headers.get("content-length")) > 3_000_000) {
        void response.body?.cancel().catch(() => {}); throw unavailable();
      }
      reader = response.body.getReader();
      let size = 0, body = ""; const decoder = new TextDecoder("utf-8", { fatal: true });
      while (true) {
        controller.signal.throwIfAborted();
        const part = await reader.read();
        controller.signal.throwIfAborted();
        size += part.value?.byteLength ?? 0;
        if (size > 3_000_000) throw unavailable();
        body += part.done ? decoder.decode() : decoder.decode(part.value, { stream: true });
        if (part.done) return JSON.parse(body) as unknown;
      }
    })()]);
  } catch { throw unavailable(); }
  finally { clearTimeout(timer); void reader?.cancel().catch(() => {}); reader?.releaseLock(); }
}

function parse(payload: unknown, kind: Kind, checkedAt: string): Entry["models"] {
  if (!Array.isArray(payload) || payload.length > 2000) throw unavailable();
  const seen = new Set<string>(); const result: Entry["models"] = [];
  for (const value of payload) {
    const row = record(value), id = row.name;
    if (row.category !== kind || !strings(row.input_modalities).includes("text") || !strings(row.output_modalities).includes(kind)
      || !strings(row.supported_endpoints).includes(kind === "text" ? "/v1/chat/completions" : "/image/{prompt}")
      || typeof id !== "string" || !/^[a-z0-9][a-z0-9._:/@+-]{0,199}$/i.test(id) || seen.has(id)
      || (kind === "image" && pollinationsGenerationExcluded(id, strings(row.aliases)))) continue;
    seen.add(id); const parameters = strings(row.supported_parameters);
    result.push({ id, name: typeof row.title === "string" ? row.title.slice(0, 200) : id, aliases: strings(row.aliases), paidOnly: row.paid_only === true,
      structuredOutput: row.supports_structured_output === true || parameters.includes("structured_outputs") || parameters.includes("json_schema"), streaming: parameters.includes("stream"),
      ...(row.pricing ? { price: normalizePollinationsPrice(row, kind, checkedAt) } : {}),
      ...(kind === "image" ? { generationSupported: pollinationsGenerationSupported(id, strings(row.input_modalities), strings(row.aliases)) } : {}),
      ...(typeof row.community === "boolean" ? { community: row.community } : {}) });
  }
  if (!result.length) throw unavailable();
  return result;
}

export async function loadPollinationsModels(ownerId: string, kind: Kind, refresh = false) {
  const [row] = await db.select().from(aiSettings).where(eq(aiSettings.id, ownerId)).limit(1);
  const personal = Boolean(row?.pollinationsKey);
  if (personal && row.pollinationsKeyExpiresAt && row.pollinationsKeyExpiresAt.getTime() <= Date.now()) {
    throw new HttpError(503, "POLLINATIONS_CONNECTION_REQUIRED", "Срок подключения Pollinations истёк. Подключите аккаунт заново.");
  }
  const apiKey = personal ? openSecret(row.pollinationsKey, secretContext(ownerId, "text:pollinations")) : undefined;
  // Validate the CURRENT permissions on every request. Revoked keys never receive stale account data.
  const key = apiKey ? record(await json("https://gen.pollinations.ai/account/key", apiKey)) : null;
  const permissions = key ? record(key.permissions).models : null;
  if (key && (key.valid !== true || (permissions !== null && (!Array.isArray(permissions) || permissions.length > 2000 || !permissions.every(v => typeof v === "string" && v.length <= 200))))) throw unavailable();
  const scope = `${kind}:${apiKey ? `${ownerId}:${createHash("sha256").update(apiKey).digest("hex")}` : "public"}`;
  let entry = cache.get(scope), stale = false;
  if (refresh || !entry || entry.checkedAt + TTL <= Date.now()) {
    let work = pending.get(scope);
    if (!work) {
      work = json(`https://gen.pollinations.ai/${kind}/models`, apiKey).then(payload => {
        const checkedAt = Date.now(), value = { models: parse(payload, kind, new Date(checkedAt).toISOString()), checkedAt };
        cache.delete(scope); cache.set(scope, value);
        if (cache.size > 128) cache.delete(cache.keys().next().value!);
        return value;
      }).finally(() => { pending.delete(scope); });
      pending.set(scope, work);
    }
    try { entry = await work; }
    catch { if (!entry || entry.checkedAt + MAX_STALE <= Date.now()) throw unavailable(); stale = true; }
  }
  const allowed = permissions === null ? null : strings(permissions);
  const models: PollinationsModel[] = entry.models.filter(model => (!allowed || [kind, model.id, ...model.aliases].some(id => allowed.includes(id)))
    && !(key?.questPollenOnly === true && model.paidOnly)).map(({ aliases: _aliases, ...model }) => ({ ...structuredClone(model), ...(model.price ? { price: { ...structuredClone(model.price), stale } } : {}) }));
  models.sort((a, b) => Number(a.community === true) - Number(b.community === true));
  return { models, checkedAt: new Date(entry.checkedAt).toISOString(), stale, personal };
}
