// VIS-1: чистые функции провайдера и промпта (без БД) — тестируются изолированно.
import { createHash } from "node:crypto";
import type { VisualKind, WorldState } from "@/db/schema";

// ─────────────────────────────────────────────────────────────
//  Контракт провайдера
// ─────────────────────────────────────────────────────────────
export type VisualProviderId = "pollinations" | "openrouter";
export type VisualOutputFormat = "png" | "jpeg" | "webp";
export type VisualRequest = { prompt: string; seed: number; width: number; height: number; model: string; endpoint?: string | null; outputFormat?: VisualOutputFormat | null };
export type MediaProvider = {
  id: string;
  defaultModel: string;
  capabilities: { generate: boolean; edit: boolean; referenceInput: boolean };
  responseFormat?: "base64-json";
  buildRequest(input: VisualRequest, apiKey?: string): { url: string; headers: Record<string, string>; method?: "POST"; body?: string };
};

export const pollinationsProvider: MediaProvider = {
  id: "pollinations",
  defaultModel: "tongyi-mai/z-image-turbo",
  // Редактирование и референсы (kontext/gptimage) требуют ключа и публичного URL исходника — см. roadmap VIS-2b.
  capabilities: { generate: true, edit: false, referenceInput: false },
  buildRequest({ prompt, seed, width, height, model }, apiKey) {
    const key = (apiKey === undefined ? process.env.POLLINATIONS_API_KEY : apiKey)?.trim();
    if (!key) throw new Error("POLLINATIONS_KEY_REQUIRED");
    const params = new URLSearchParams({ model, width: String(width), height: String(height), seed: String(seed), safe: "true" });
    const encoded = encodeURIComponent(prompt);
    return { url: `https://gen.pollinations.ai/image/${encoded}?${params}`, headers: { Authorization: `Bearer ${key}` } };
  },
};

export const openrouterProvider: MediaProvider = {
  id: "openrouter",
  defaultModel: "bytedance-seed/seedream-4.5",
  capabilities: { generate: true, edit: false, referenceInput: false },
  responseFormat: "base64-json",
  buildRequest({ prompt, seed, width, height, model, endpoint, outputFormat }, apiKey) {
    const key = apiKey?.trim();
    if (!key) throw new Error("OPENROUTER_KEY_REQUIRED");
    if (!endpoint || !/^[a-z0-9][a-z0-9._:/@+-]{0,149}$/i.test(endpoint) || endpoint.includes("://")) throw new Error("OPENROUTER_ENDPOINT_REQUIRED");
    return {
      url: "https://openrouter.ai/api/v1/images", method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, size: `${width}x${height}`, seed, n: 1, ...(outputFormat ? { output_format: outputFormat } : {}), provider: { only: [endpoint], allow_fallbacks: false } }),
    };
  },
};

export const PROVIDERS: Record<string, MediaProvider> = { pollinations: pollinationsProvider, openrouter: openrouterProvider };

export function visualConfig() {
  // The application payer remains Pollinations-only; personal OpenRouter is selected per owner.
  const provider = pollinationsProvider;
  return {
    enabled: process.env.CHRONICLE_VISUALS_DISABLED !== "1",
    provider,
    model: process.env.CHRONICLE_VISUAL_MODEL?.trim() || provider.defaultModel,
    dailyLimit: Math.max(1, Number(process.env.CHRONICLE_VISUAL_DAILY_LIMIT) || 40),
    authenticated: !!process.env.POLLINATIONS_API_KEY?.trim(),
  };
}

// ─────────────────────────────────────────────────────────────
//  Промпт и сиды (чистые функции)
// ─────────────────────────────────────────────────────────────
export function seedFor(sessionId: string, subjectKey: string): number {
  return parseInt(createHash("sha256").update(`${sessionId}:${subjectKey}`).digest("hex").slice(0, 8), 16) % 2_000_000_000;
}

export function styleFor(tone: string, worldName: string): string {
  const t = `${tone} ${worldName}`.toLowerCase();
  if (/киберпанк|неон|cyber/.test(t)) return "cinematic cyberpunk illustration, neon rim light, rain-soaked, detailed";
  if (/хоррор|ужас|мрач|gothic/.test(t)) return "dark atmospheric illustration, muted palette, volumetric fog, painterly";
  if (/космос|sci|фантаст|станц|звезд/.test(t)) return "cinematic science fiction concept art, soft volumetric light, detailed";
  if (/детектив|нуар|поезд|noir/.test(t)) return "moody noir illustration, film grain, dramatic lighting";
  if (/быт|повседнев|жизн|slice|современ|реализм/.test(t)) return "warm realistic illustration, natural light, everyday atmosphere, gentle colors";
  return "painterly fantasy illustration, cinematic composition, rich light, detailed";
}

export const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

export type PromptInput = {
  kind: VisualKind;
  world: Pick<WorldState, "tone" | "worldName" | "era" | "currentLocation">;
  subjectName: string;
  passport: string;
  locationDescription?: string;
  sceneNarration?: string;
  presentPassports?: { name: string; passport: string }[];
  objects?: string[];
  partOfDay?: string;
};

/** Служебные ID и ключи не добавляются; авторские описания передаются как визуальный контекст. */
export function buildVisualPrompt(p: PromptInput): string {
  const style = styleFor(p.world.tone, p.world.worldName);
  const era = p.world.era ? `era: ${clip(p.world.era, 60)}` : "";
  if (p.kind === "portrait") {
    return clip(`${style}. Character portrait, head and shoulders, consistent character design. ${p.passport ? clip(p.passport, 420) : clip(p.subjectName, 80)}. ${era}. No text, no watermark.`, 900);
  }
  if (p.kind === "location") {
    return clip(`${style}. Establishing shot of a place, no people in focus. ${clip(p.subjectName, 80)}: ${clip(p.locationDescription || p.passport, 360)}. ${p.partOfDay ? `Time of day: ${p.partOfDay}.` : ""} ${era}. No text, no watermark.`, 900);
  }
  const people = (p.presentPassports ?? []).slice(0, 3).map((x) => `${clip(x.name, 40)} — ${clip(x.passport, 140)}`).join("; ");
  return clip(`${style}. Story scene illustration. Place: ${clip(p.world.currentLocation, 80)}${p.locationDescription ? ` (${clip(p.locationDescription, 160)})` : ""}. ${p.partOfDay ? `Time of day: ${p.partOfDay}.` : ""} Moment: ${clip(p.sceneNarration ?? "", 360)}. ${people ? `Characters: ${people}.` : ""} ${p.objects?.length ? `Notable objects: ${p.objects.slice(0, 4).join(", ")}.` : ""} ${era}. No text, no watermark.`, 900);
}


const MAX_BYTES = 8 * 1024 * 1024;
const MAX_BASE64_BYTES = Math.ceil(MAX_BYTES / 3) * 4;
const MAX_JSON_BYTES = MAX_BASE64_BYTES + 64 * 1024;

/** Sniff raster bytes independently of the provider's MIME claim. SVG is never accepted. */
function rasterMime(image: Buffer): string | undefined {
  if (image.length >= 8 && image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (image.length >= 3 && image[0] === 255 && image[1] === 216 && image[2] === 255) return "image/jpeg";
  if (image.length >= 12 && image.toString("ascii", 0, 4) === "RIFF" && image.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (image.length >= 6 && ["GIF87a", "GIF89a"].includes(image.toString("ascii", 0, 6))) return "image/gif";
}

function decodeImageJson(bytes: Buffer): { image: Buffer; mimeType: string } {
  let data: unknown;
  try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("PROVIDER_NOT_IMAGE"); }
  if (!data || typeof data !== "object" || !("data" in data) || !Array.isArray(data.data) || data.data.length !== 1) throw new Error("PROVIDER_NOT_IMAGE");
  const item: unknown = data.data[0];
  if (!item || typeof item !== "object" || !("b64_json" in item) || typeof item.b64_json !== "string") throw new Error("PROVIDER_NOT_IMAGE");
  const encoded = item.b64_json;
  if (encoded.length > MAX_BASE64_BYTES) throw new Error("PROVIDER_BAD_SIZE");
  if (!encoded.length || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("PROVIDER_NOT_IMAGE");
  const image = Buffer.from(encoded, "base64");
  if (!image.length || image.length > MAX_BYTES) throw new Error("PROVIDER_BAD_SIZE");
  const mimeType = rasterMime(image);
  if (!mimeType || ("media_type" in item && item.media_type !== undefined && item.media_type !== mimeType)) throw new Error("PROVIDER_NOT_IMAGE");
  return { image, mimeType };
}

export async function fetchFromProvider(provider: MediaProvider, request: VisualRequest, fetchImpl: typeof fetch = fetch, apiKey?: string): Promise<{ image: Buffer; mimeType: string }> {
  const { url, headers, method, body } = provider.buildRequest(request, apiKey);
  const signal = AbortSignal.timeout(90_000);
  const bounded = async <T>(operation: () => Promise<T>) => {
    if (signal.aborted) throw new Error("PROVIDER_TIMEOUT");
    let abort!: () => void;
    try {
      return await Promise.race([Promise.resolve().then(() => {
        if (signal.aborted) throw new Error("PROVIDER_TIMEOUT");
        return operation();
      }), new Promise<never>((_, reject) => {
        abort = () => reject(new Error("PROVIDER_TIMEOUT")); signal.addEventListener("abort", abort, { once: true });
      })]);
    } catch (error) {
      if (signal.aborted) throw new Error("PROVIDER_TIMEOUT");
      throw error;
    } finally { signal.removeEventListener("abort", abort); }
  };
  const response = await bounded(() => fetchImpl(url, { headers, ...(method ? { method, body, redirect: "error" as const } : {}), signal, cache: "no-store" }).then(response => {
    if (signal.aborted) void response.body?.cancel().catch(() => {});
    return response;
  }));
  try {
    if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}`);
    const mimeType = (response.headers.get("content-type") ?? "").split(";")[0].trim();
    const json = provider.responseFormat === "base64-json";
    const limit = json ? MAX_JSON_BYTES : MAX_BYTES;
    if (json ? mimeType !== "application/json" : !/^image\/(jpeg|png|webp|gif)$/.test(mimeType)) throw new Error("PROVIDER_NOT_IMAGE");
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > limit) throw new Error("PROVIDER_BAD_SIZE");
    let image: Buffer;
    if (response.body) {
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      const cancel = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        while (true) {
          const next = await bounded(() => reader.read());
          if (signal.aborted) throw new Error("PROVIDER_TIMEOUT");
          if (next.done) break;
          total += next.value.byteLength;
          if (total > limit) throw new Error("PROVIDER_BAD_SIZE");
          chunks.push(Buffer.from(next.value));
        }
      } finally { signal.removeEventListener("abort", cancel); cancel(); reader.releaseLock(); }
      image = Buffer.concat(chunks, total);
    } else {
      image = Buffer.from(await bounded(() => response.arrayBuffer()));
    }
    if (!image.length || image.length > limit) throw new Error("PROVIDER_BAD_SIZE");
    if (json) return decodeImageJson(image);
    return { image, mimeType };
  } catch (error) {
    if (!response.body?.locked) void response.body?.cancel().catch(() => {});
    if (signal.aborted) throw new Error("PROVIDER_TIMEOUT");
    throw error;
  }
}
