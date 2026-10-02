import { eq } from "drizzle-orm";
import { db } from "@/db";
import { aiSettings } from "@/db/schema";
import { getRawSettingsRow } from "./ai-settings";
import { HttpError } from "./http";
import { sealSecret, secretContext } from "./secret-vault";

export type TextProvider = "gemini" | "openrouter" | "pollinations";
export type TextProviderSettingsInput = {
  provider: TextProvider;
  model: string;
  apiKey?: string;
  clearKey?: boolean;
  useLiveAI?: boolean;
};

function invalid(): never { throw new HttpError(400, "INVALID_INPUT", "Некорректные настройки текстового провайдера."); }

export function parseTextProviderSettings(body: Record<string, unknown>): TextProviderSettingsInput {
  if (Object.keys(body).some(key => !["provider", "model", "apiKey", "clearKey", "useLiveAI"].includes(key))) invalid();
  if (typeof body.provider !== "string" || !["gemini", "openrouter", "pollinations"].includes(body.provider)) invalid();
  if (typeof body.model !== "string") invalid();
  const model = body.model.trim();
  if (model.length > 200 || (model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$/.test(model)) || (body.provider !== "gemini" && !model)) invalid();
  if (body.clearKey !== undefined && typeof body.clearKey !== "boolean") invalid();
  if (body.useLiveAI !== undefined && typeof body.useLiveAI !== "boolean") invalid();
  if (body.apiKey !== undefined && (typeof body.apiKey !== "string" || !body.apiKey.trim() || body.apiKey.length > 4096 || /[\x00-\x20\x7f]/.test(body.apiKey.trim()))) invalid();
  if (body.clearKey === true && body.apiKey !== undefined) invalid();
  if (body.provider === "gemini" && (body.apiKey !== undefined || body.clearKey === true)) invalid();
  return {
    provider: body.provider as TextProvider, model,
    ...(body.apiKey !== undefined ? { apiKey: (body.apiKey as string).trim() } : {}),
    ...(body.clearKey !== undefined ? { clearKey: body.clearKey as boolean } : {}),
    ...(body.useLiveAI !== undefined ? { useLiveAI: body.useLiveAI as boolean } : {}),
  };
}

function view(row: Awaited<ReturnType<typeof getRawSettingsRow>>) {
  return {
    provider: row.textProvider as TextProvider,
    model: row.textModel,
    openrouterConfigured: Boolean(row.openrouterKey),
    pollinationsConfigured: Boolean(row.pollinationsKey),
    useLiveAI: row.useLiveAI,
    ...(row.pollinationsKeyExpiresAt ? { pollinationsKeyExpiresAt: row.pollinationsKeyExpiresAt.toISOString() } : {}),
  };
}

export async function getTextProviderSettings(ownerId: string) {
  return view(await getRawSettingsRow(ownerId));
}

export async function saveTextProviderSettings(ownerId: string, input: TextProviderSettingsInput) {
  const parsed = parseTextProviderSettings(input);
  const row = await getRawSettingsRow(ownerId);
  const patch: Partial<typeof aiSettings.$inferInsert> = { textProvider: parsed.provider, textModel: parsed.model, updatedAt: new Date() };
  let hasCredential = parsed.provider === "gemini" ? Boolean(row.keys?.length) : Boolean(parsed.provider === "openrouter" ? row.openrouterKey : row.pollinationsKey);
  if (parsed.apiKey !== undefined || parsed.clearKey) {
    const value = parsed.clearKey ? "" : sealSecret(parsed.apiKey!, secretContext(ownerId, `text:${parsed.provider}`));
    if (parsed.provider === "openrouter") patch.openrouterKey = value;
    if (parsed.provider === "pollinations") { patch.pollinationsKey = value; patch.pollinationsKeyExpiresAt = null; }
    hasCredential = Boolean(value);
  }
  patch.useLiveAI = hasCredential && (parsed.useLiveAI ?? row.useLiveAI);
  await db.update(aiSettings).set(patch).where(eq(aiSettings.id, ownerId));
  return getTextProviderSettings(ownerId);
}

/** OAuth attaches credentials without changing the user's selected narrator or live preference. */
export async function attachPollinationsKey(ownerId: string, key: string, expiresAt?: Date) {
  const parsed = parseTextProviderSettings({ provider: "pollinations", model: "openai", apiKey: key });
  if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) invalid();
  await getRawSettingsRow(ownerId);
  await db.update(aiSettings).set({
    pollinationsKey: sealSecret(parsed.apiKey!, secretContext(ownerId, "text:pollinations")),
    pollinationsKeyExpiresAt: expiresAt ?? null, updatedAt: new Date(),
  }).where(eq(aiSettings.id, ownerId));
}
