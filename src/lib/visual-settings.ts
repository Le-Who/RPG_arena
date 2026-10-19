import { db } from "@/db";
import { aiSettings, visualSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { visualConfig } from "./visual-provider";
import { getRawSettingsRow } from "./ai-settings";
import { HttpError } from "./http";
import { openSecret, secretContext } from "./secret-vault";

export type VisualAccountSource = "application" | "personal";
export function parseVisualPreferences(body: Record<string, unknown>) {
  if (Object.keys(body).some(key => !["accountSource", "model"].includes(key)) || typeof body.accountSource !== "string" || !["application", "personal"].includes(body.accountSource)
    || typeof body.model !== "string" || !/^[a-z0-9][a-z0-9._:/@+-]{0,199}$/i.test(body.model.trim())) {
    throw new HttpError(400, "INVALID_INPUT", "Выберите аккаунт Pollinations и укажите корректный ID модели изображения.");
  }
  return { accountSource: body.accountSource as VisualAccountSource, model: body.model.trim() };
}

/** The server environment supplies a fallback; an administrator's saved choice wins. */
export async function readVisualConfig(ownerId?: string | null) {
  const base = visualConfig();
  const [saved] = await db.select({ model: visualSettings.model }).from(visualSettings).where(eq(visualSettings.id, 1)).limit(1);
  const [personal] = ownerId ? await db.select().from(aiSettings).where(eq(aiSettings.id, ownerId)).limit(1) : [];
  const accountSource = personal?.visualAccountSource ?? "application";
  const connected = Boolean(personal?.pollinationsKey);
  const expired = Boolean(personal?.pollinationsKeyExpiresAt && personal.pollinationsKeyExpiresAt.getTime() <= Date.now());
  return { ...base, accountSource, model: accountSource === "personal" ? personal?.pollinationsImageModel || base.model : saved?.model ?? base.model,
    availableAccounts: { application: base.authenticated, personal: connected && !expired },
    authenticated: accountSource === "personal" ? connected && !expired : base.authenticated };
}

function visualPreferencesView(row: Awaited<ReturnType<typeof getRawSettingsRow>>, application: Awaited<ReturnType<typeof readVisualConfig>>) {
  return { accountSource: row.visualAccountSource, model: row.pollinationsImageModel || application.provider.defaultModel,
    applicationModel: application.model, applicationConfigured: application.authenticated,
    pollinationsConfigured: Boolean(row.pollinationsKey),
    ...(row.pollinationsKeyExpiresAt ? { expiresAt: row.pollinationsKeyExpiresAt.toISOString() } : {}) };
}

export async function getVisualPreferences(ownerId: string) {
  const [row, application] = await Promise.all([getRawSettingsRow(ownerId), readVisualConfig()]);
  return visualPreferencesView(row, application);
}

export async function saveVisualPreferences(ownerId: string, body: Record<string, unknown>) {
  const input = parseVisualPreferences(body);
  await getRawSettingsRow(ownerId);
  const [saved] = await db.update(aiSettings).set({ visualAccountSource: input.accountSource, pollinationsImageModel: input.model, updatedAt: new Date() }).where(eq(aiSettings.id, ownerId)).returning();
  if (!saved) throw new HttpError(409, "SETTINGS_CHANGED", "Настройки изменились во время сохранения. Повторите попытку.");
  return visualPreferencesView(saved, await readVisualConfig());
}

/** Resolve only the recorded payer. A missing personal key never spends application funds. */
export async function visualCredential(ownerId: string | null, accountSource: VisualAccountSource): Promise<string> {
  if (accountSource === "application") {
    const key = process.env.POLLINATIONS_API_KEY?.trim();
    if (!key) throw new HttpError(503, "VISUAL_PROVIDER_UNCONFIGURED", "Аккаунт приложения Pollinations не настроен. Выберите личный аккаунт в настройках.");
    return key;
  }
  const [row] = ownerId ? await db.select().from(aiSettings).where(eq(aiSettings.id, ownerId)).limit(1) : [];
  if (!row?.pollinationsKey || (row.pollinationsKeyExpiresAt && row.pollinationsKeyExpiresAt.getTime() <= Date.now())) {
    throw new HttpError(503, "POLLINATIONS_CONNECTION_REQUIRED", "Подключите личный аккаунт Pollinations заново в настройках.");
  }
  return openSecret(row.pollinationsKey, secretContext(row.id, "text:pollinations"));
}

export async function saveVisualModel(model: string, adminAccountId: string): Promise<void> {
  await db.insert(visualSettings).values({ id: 1, model, updatedBy: adminAccountId })
    .onConflictDoUpdate({ target: visualSettings.id, set: { model, updatedBy: adminAccountId, updatedAt: new Date() } });
}
