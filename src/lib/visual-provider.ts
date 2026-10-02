// VIS-1: чистые функции провайдера и промпта (без БД) — тестируются изолированно.
import { createHash } from "node:crypto";
import type { VisualKind, WorldState } from "@/db/schema";

// ─────────────────────────────────────────────────────────────
//  Контракт провайдера
// ─────────────────────────────────────────────────────────────
export type VisualRequest = { prompt: string; seed: number; width: number; height: number; model: string };
export type MediaProvider = {
  id: string;
  defaultModel: string;
  capabilities: { generate: boolean; edit: boolean; referenceInput: boolean };
  buildRequest(input: VisualRequest): { url: string; headers: Record<string, string> };
};

export const pollinationsProvider: MediaProvider = {
  id: "pollinations",
  defaultModel: "tongyi-mai/z-image-turbo",
  // Редактирование и референсы (kontext/gptimage) требуют ключа и публичного URL исходника — см. roadmap VIS-2b.
  capabilities: { generate: true, edit: false, referenceInput: false },
  buildRequest({ prompt, seed, width, height, model }) {
    const key = process.env.POLLINATIONS_API_KEY?.trim();
    if (!key) throw new Error("POLLINATIONS_KEY_REQUIRED");
    const params = new URLSearchParams({ model, width: String(width), height: String(height), seed: String(seed), safe: "true" });
    const encoded = encodeURIComponent(prompt);
    return { url: `https://gen.pollinations.ai/image/${encoded}?${params}`, headers: { Authorization: `Bearer ${key}` } };
  },
};

export const PROVIDERS: Record<string, MediaProvider> = { pollinations: pollinationsProvider };

export function visualConfig() {
  const provider = PROVIDERS[process.env.CHRONICLE_VISUAL_PROVIDER ?? "pollinations"] ?? pollinationsProvider;
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

/** Только визуальное описание: без имён пользователя, ключей и служебных ID (приватность VIS). */
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

export async function fetchFromProvider(provider: MediaProvider, request: VisualRequest, fetchImpl: typeof fetch = fetch): Promise<{ image: Buffer; mimeType: string }> {
  const { url, headers } = provider.buildRequest(request);
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(90_000), cache: "no-store" });
  if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}`);
  const mimeType = (response.headers.get("content-type") ?? "").split(";")[0].trim();
  if (!/^image\/(jpeg|png|webp|gif)$/.test(mimeType)) throw new Error("PROVIDER_NOT_IMAGE");
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) throw new Error("PROVIDER_BAD_SIZE");
  let image: Buffer;
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > MAX_BYTES) throw new Error("PROVIDER_BAD_SIZE");
        chunks.push(Buffer.from(next.value));
      }
    } finally { reader.releaseLock(); }
    image = Buffer.concat(chunks, total);
  } else {
    image = Buffer.from(await response.arrayBuffer());
  }
  if (!image.length || image.length > MAX_BYTES) throw new Error("PROVIDER_BAD_SIZE");
  return { image, mimeType };
}
