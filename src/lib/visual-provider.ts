// VIS-1: чистые функции провайдера и промпта (без БД) — тестируются изолированно.
import { createHash } from "node:crypto";
import type { VisualKind, WorldState } from "@/db/schema";
import { assertOpenAIImageModel, OPENAI_IMAGE_DEFAULT_MODEL } from "./openai-image-catalog";

// ─────────────────────────────────────────────────────────────
//  Контракт провайдера
// ─────────────────────────────────────────────────────────────
export type VisualProviderId = "pollinations" | "openrouter" | "openai";
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

/** Sizes shared by all supported GPT Image models and stored with the generated visual. */
export function normalizeOpenAIImageDimensions(width: number, height: number): { width: number; height: number } {
  if (width === height) return { width: 1024, height: 1024 };
  return width > height ? { width: 1536, height: 1024 } : { width: 1024, height: 1536 };
}

export const openaiProvider: MediaProvider = {
  id: "openai",
  defaultModel: OPENAI_IMAGE_DEFAULT_MODEL,
  capabilities: { generate: true, edit: false, referenceInput: false },
  responseFormat: "base64-json",
  buildRequest({ prompt, width, height, model }, apiKey) {
    const key = apiKey?.trim();
    if (!key) throw new Error("OPENAI_KEY_REQUIRED");
    assertOpenAIImageModel(model);
    // All supported GPT Image models accept these sizes. The application's
    // 1024x576 scene size is below GPT Image 2's minimum pixel count.
    const dimensions = normalizeOpenAIImageDimensions(width, height);
    return {
      url: "https://api.openai.com/v1/images/generations", method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      // GPT Image returns base64 directly; response_format and seed are unsupported.
      body: JSON.stringify({ model, prompt, size: `${dimensions.width}x${dimensions.height}`, n: 1, output_format: "png" }),
    };
  },
};

export const PROVIDERS: Record<string, MediaProvider> = { pollinations: pollinationsProvider, openrouter: openrouterProvider, openai: openaiProvider };

export function visualConfig() {
  // The application payer remains Pollinations-only; personal providers are selected per owner.
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

export function styleFor(tone: string, _worldName: string): string {
  // Names are context, not evidence for a genre or costume. Combine explicit
  // tone cues so a gothic comedy does not lose either part to a first-match rule.
  const neutral = "Neutral story illustration, natural proportions and context-appropriate lighting";
  const t = (tone ?? "").toLowerCase(), cues: string[] = [];
  // Negation makes keyword interpretation ambiguous. Keep the authoritative raw
  // tone in the prompt and let it guide rendering without an invented directive.
  if (/(?:^|[\s,;:()—–-])(?:без|не|нет|no|not|without)(?=$|[\s/—–-])/u.test(t)) return neutral;
  if (/киберпанк|cyberpunk|неонов/.test(t)) cues.push("cyberpunk lighting");
  if (/готич|готик|gothic/.test(t)) cues.push("dark gothic atmosphere");
  else if (/хоррор|ужас|мрач|horror/.test(t)) cues.push("dark atmospheric lighting");
  if (/космос|космич|science.?fiction|sci.?fi|научн.{0,12}фантаст/.test(t)) cues.push("science-fiction design");
  if (/фэнтези|фентези|fantasy/.test(t)) cues.push("fantasy design");
  if (/нуар|noir/.test(t)) cues.push("noir contrast");
  if (/быт|повседнев|slice|современ|реализм|реалист|grounded/.test(t)) cues.push("naturalistic lighting");
  if (/комед|юмор|ирони|смешн|сатир|фарс|comedy|comedic|humou?r|satir/.test(t)) cues.push("comedic mood and expressive staging");
  return cues.length ? `Story illustration, ${cues.join(", ")}` : neutral;
}

export const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
export const MAX_VISUAL_PROMPT_LENGTH = 2200;

export type PromptInput = {
  kind: VisualKind;
  world: Pick<WorldState, "tone" | "worldName" | "era" | "currentLocation"> & {
    narrator?: Pick<NonNullable<WorldState["narrator"]>, "realism" | "tension" | "note">;
  };
  subjectName: string;
  passport: string;
  styleOverride?: string;
  locationDescription?: string;
  /** One latest relevant narrator excerpt, for portraits and places as well as scenes. */
  sceneNarration?: string;
  presentPassports?: { name: string; passport: string }[];
  objects?: string[];
  partOfDay?: string;
};

/** Служебные ID и ключи не добавляются; авторские описания передаются как визуальный контекст. */
export function buildVisualPrompt(p: PromptInput): string {
  // Independent field budgets fit MAX_VISUAL_PROMPT_LENGTH even when every
  // field is filled. Never truncate the joined prompt: that would drop the
  // last character's appearance or the final identity instructions.
  const parts: string[] = [];
  const add = (label: string, value: string | undefined, budget: number) => {
    const content = clip(value ?? "", budget);
    if (content) parts.push(`${label}: ${content}.`);
  };
  const override = clip(p.styleOverride ?? "", 400);
  if (override) {
    add("Visual style override", override, 400);
    parts.push("Override controls rendering; preserve world facts and identities.");
  } else {
    parts.push(`${styleFor(p.world.tone, p.world.worldName)}.`);
    parts.push("Match the story tone and current moment.");
  }
  add("World", p.world.worldName, 60);
  add("Era", p.world.era, 60);
  add("Story tone", p.world.tone, 120);
  add("Current place", p.world.currentLocation, 60);
  if (p.kind === "portrait") {
    parts.push("Character portrait, head and shoulders, consistent character design.");
    add("Character", p.subjectName, 60);
    add("Appearance", p.passport, 320);
  } else if (p.kind === "location") {
    parts.push("Establishing shot of a place, no people in focus.");
    add("Place", p.subjectName, 60);
    add("Place details", p.locationDescription || p.passport, 320);
  } else {
    parts.push("Story scene illustration.");
    add("Place details", p.locationDescription, 100);
    const people = (p.presentPassports ?? []).slice(0, 3).map(person => `${clip(person.name, 32)} — ${clip(person.passport, 110)}`);
    if (people.length) parts.push(`Characters: ${people.join("; ")}.`);
    const objects = (p.objects ?? []).slice(0, 3).map(object => clip(object, 24)).filter(Boolean);
    if (objects.length) parts.push(`Objects: ${objects.join(", ")}.`);
  }
  add(p.kind === "portrait" ? "Atmosphere only; retain this character's appearance and pose" : "Current moment", p.sceneNarration, 200);
  add("Time", p.partOfDay, 24);
  if (p.world.narrator) {
    add("Narrator realism", p.world.narrator.realism, 16);
    add("Narrator tension", p.world.narrator.tension, 8);
    add("Narrator direction", p.world.narrator.note, 100);
  }
  parts.push("Names identify subjects; do not infer genre, mood or costume from a name. Preserve established appearance. No text, no watermark.");
  return parts.join(" ");
}


const MAX_BYTES = 8 * 1024 * 1024;
const MAX_BASE64_BYTES = Math.ceil(MAX_BYTES / 3) * 4;
const MAX_JSON_BYTES = MAX_BASE64_BYTES + 64 * 1024;
const OPENAI_HTTP_ERRORS: Record<number, string> = {
  400: "OPENAI_REQUEST_REJECTED",
  401: "OPENAI_AUTH_FAILED",
  403: "OPENAI_ACCESS_DENIED",
  404: "OPENAI_MODEL_UNAVAILABLE",
  429: "OPENAI_RATE_LIMITED",
};

function safeOpenAITransportError(error: unknown): Error {
  const message = error instanceof Error ? error.message : "";
  // Never propagate untrusted transport/error-body text containing a personal key.
  const safe = ["PROVIDER_TIMEOUT", "PROVIDER_NOT_IMAGE", "PROVIDER_BAD_SIZE", ...Object.values(OPENAI_HTTP_ERRORS)].includes(message) || /^PROVIDER_HTTP_[45]\d{2}$/.test(message);
  return new Error(safe ? message : "PROVIDER_ERROR");
}

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

export function visualProviderTimeoutMs(providerId: string): number {
  // OpenAI documents up to two minutes for complex image prompts; allow transfer headroom.
  return providerId === "openai" ? 150_000 : 90_000;
}

export async function fetchFromProvider(provider: MediaProvider, request: VisualRequest, fetchImpl: typeof fetch = fetch, apiKey?: string): Promise<{ image: Buffer; mimeType: string }> {
  const { url, headers, method, body } = provider.buildRequest(request, apiKey);
  const signal = AbortSignal.timeout(visualProviderTimeoutMs(provider.id));
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
  })).catch(error => { throw provider.id === "openai" ? safeOpenAITransportError(error) : error; });
  try {
    if (!response.ok) throw new Error((provider.id === "openai" && OPENAI_HTTP_ERRORS[response.status]) || `PROVIDER_HTTP_${response.status}`);
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
    if (rasterMime(image) !== mimeType) throw new Error("PROVIDER_NOT_IMAGE");
    return { image, mimeType };
  } catch (error) {
    if (!response.body?.locked) void response.body?.cancel().catch(() => {});
    if (signal.aborted) throw new Error("PROVIDER_TIMEOUT");
    throw provider.id === "openai" ? safeOpenAITransportError(error) : error;
  }
}
