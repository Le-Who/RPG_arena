import { eq } from "drizzle-orm";
import { db } from "@/db";
import { aiSettings } from "@/db/schema";
import { getRawSettingsRow } from "./ai-settings";
import { HttpError } from "./http";
import { sealSecret, secretContext } from "./secret-vault";
import { settingsCredentialsView } from "./settings-credentials-view";

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
  if (model.length > 200 || (model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$/.test(model)) || (body.provider !== "gemini" && !model && !(body.provider === "pollinations" && body.useLiveAI === false))) invalid();
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
  const { credentialIssues } = settingsCredentialsView(row);
  return {
    provider: row.textProvider as TextProvider,
    model: row.textModel,
    openrouterConfigured: Boolean(row.openrouterKey),
    pollinationsConfigured: Boolean(row.pollinationsKey),
    useLiveAI: row.useLiveAI,
    ...(credentialIssues.length ? { credentialIssues } : {}),
    ...(row.pollinationsKeyExpiresAt ? { pollinationsKeyExpiresAt: row.pollinationsKeyExpiresAt.toISOString() } : {}),
  };
}

export async function getTextProviderSettings(ownerId: string) {
  return view(await getRawSettingsRow(ownerId));
}

export async function saveTextProviderSettings(ownerId: string, input: TextProviderSettingsInput) {
  const parsed = parseTextProviderSettings(input);
  await getRawSettingsRow(ownerId);
  const patch: Partial<typeof aiSettings.$inferInsert> = { textProvider: parsed.provider, textModel: parsed.model, updatedAt: new Date() };
  if (parsed.apiKey !== undefined || parsed.clearKey) {
    const value = parsed.clearKey ? "" : sealSecret(parsed.apiKey!, secretContext(ownerId, `text:${parsed.provider}`));
    if (parsed.provider === "openrouter") patch.openrouterKey = value;
    if (parsed.provider === "pollinations") { patch.pollinationsKey = value; patch.pollinationsKeyExpiresAt = null; }
  }
  if (parsed.useLiveAI !== undefined) patch.useLiveAI = parsed.useLiveAI;
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

export type ProviderConnectionInput = { provider: TextProvider; apiKey?: string; clearKey?: boolean };
function invalidConnection(): never { throw new HttpError(400, "INVALID_INPUT", "Некорректные настройки подключения сервиса."); }

/** Connections never select a task or enable live calls. Gemini append uses the settings endpoint. */
export function parseProviderConnection(body: Record<string, unknown>): ProviderConnectionInput {
  if (Object.keys(body).some(key => !["provider", "apiKey", "clearKey"].includes(key))) invalidConnection();
  if (typeof body.provider !== "string" || !["gemini", "openrouter", "pollinations"].includes(body.provider)) invalidConnection();
  if (body.clearKey !== undefined && typeof body.clearKey !== "boolean") invalidConnection();
  if (body.apiKey !== undefined && (typeof body.apiKey !== "string" || !body.apiKey.trim() || body.apiKey.length > 4096 || /[\x00-\x20\x7f]/.test(body.apiKey.trim()))) invalidConnection();
  if ((body.apiKey !== undefined) === (body.clearKey === true)) invalidConnection();
  return { provider: body.provider as TextProvider, ...(body.apiKey !== undefined ? { apiKey: (body.apiKey as string).trim() } : { clearKey: true }) };
}

function connectionsView(row: Awaited<ReturnType<typeof getRawSettingsRow>>) {
  const { credentialIssues } = settingsCredentialsView(row);
  return {
    geminiConfigured: Boolean(row.keys?.length),
    openrouterConfigured: Boolean(row.openrouterKey),
    pollinationsConfigured: Boolean(row.pollinationsKey),
    ...(credentialIssues.length ? { credentialIssues } : {}),
    ...(row.pollinationsKeyExpiresAt ? { pollinationsKeyExpiresAt: row.pollinationsKeyExpiresAt.toISOString() } : {}),
  };
}

export async function getProviderConnections(ownerId: string) {
  return connectionsView(await getRawSettingsRow(ownerId));
}

/** Credential-only mutations preserve narrator, visual preferences and the user's Live toggle even on removal. */
export async function saveProviderConnection(ownerId: string, body: Record<string, unknown>) {
  const input = parseProviderConnection(body);
  await getRawSettingsRow(ownerId);
  const key = input.clearKey ? "" : sealSecret(input.apiKey!, secretContext(ownerId, input.provider === "gemini" ? "gemini" : `text:${input.provider}`));
  const patch: Partial<typeof aiSettings.$inferInsert> = { updatedAt: new Date() };
  if (input.provider === "gemini") patch.keys = key ? [key] : [];
  if (input.provider === "openrouter") patch.openrouterKey = key;
  if (input.provider === "pollinations") { patch.pollinationsKey = key; patch.pollinationsKeyExpiresAt = null; }
  const [saved] = await db.update(aiSettings).set(patch).where(eq(aiSettings.id, ownerId)).returning();
  if (!saved) throw new HttpError(409, "SETTINGS_CHANGED", "Настройки изменились во время сохранения. Повторите попытку.");
  return connectionsView(saved);
}
