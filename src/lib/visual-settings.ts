import { db } from "@/db";
import { aiSettings, visualSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { PROVIDERS, visualConfig, type VisualOutputFormat, type VisualProviderId } from "./visual-provider";
import { getRawSettingsRow } from "./ai-settings";
import { HttpError } from "./http";
import { openSecret, secretContext } from "./secret-vault";
import { assertPollinationsGenerationModel } from "./visual-models";
import { resolveOpenRouterImageEndpoint } from "./openrouter-image-catalog";

export type VisualAccountSource = "application" | "personal";
export type VisualPreferencesInput = { enabled: boolean; provider: VisualProviderId; accountSource: VisualAccountSource; model: string; endpoint: string | null };
export function parseVisualPreferences(body: Record<string, unknown>): VisualPreferencesInput {
  const enabled = body.enabled === undefined ? true : body.enabled;
  const provider = body.provider === undefined ? "pollinations" : body.provider;
  const endpoint = body.endpoint ?? null;
  if (Object.keys(body).some(key => !["enabled", "provider", "accountSource", "model", "endpoint"].includes(key))
    || typeof enabled !== "boolean" || (provider !== "pollinations" && provider !== "openrouter")
    || typeof body.accountSource !== "string" || !["application", "personal"].includes(body.accountSource)
    || typeof body.model !== "string" || (body.model.trim() ? !/^[a-z0-9][a-z0-9._:/@+-]{0,199}$/i.test(body.model.trim()) : enabled)
    || (endpoint !== null && (typeof endpoint !== "string" || !/^[a-z0-9][a-z0-9._:/@+-]{0,149}$/i.test(endpoint) || endpoint.includes("://")))
    || (provider === "openrouter" && (body.accountSource !== "personal" || (enabled && !endpoint)))
    || (provider === "pollinations" && endpoint !== null)) {
    throw new HttpError(400, "INVALID_INPUT", "Выберите сервис, доступный аккаунт и модель иллюстраций.");
  }
  return { enabled, provider, accountSource: body.accountSource as VisualAccountSource, model: body.model.trim(), endpoint };
}

/** Rechecked at save, admission and retry. A manual model ID does not bypass known incompatibility. */
export async function assertVisualGenerationSelection(provider: string, model: string, endpoint: string | null): Promise<{ outputFormat: VisualOutputFormat | null }> {
  if (provider === "pollinations") { assertPollinationsGenerationModel(model); return { outputFormat: null }; }
  else if (provider === "openrouter") {
    if (!endpoint) throw new HttpError(400, "INVALID_INPUT", "Выберите доступный маршрут модели OpenRouter.");
    const resolved = await resolveOpenRouterImageEndpoint(model, endpoint);
    const descriptor = resolved.supportedParameters.output_format;
    const formats = descriptor && typeof descriptor === "object" && "values" in descriptor && Array.isArray(descriptor.values) ? descriptor.values : [];
    // Pin a supported raster format so a mixed raster/SVG endpoint cannot choose SVG by default.
    return { outputFormat: (["png", "jpeg", "webp"] as const).find(format => formats.includes(format)) ?? null };
  } else throw new HttpError(400, "INVALID_INPUT", "Выберите доступный сервис иллюстраций.");
}

/** The server environment supplies a fallback; an administrator's saved choice wins. */
export async function readVisualConfig(ownerId?: string | null) {
  const base = visualConfig();
  const [saved] = await db.select({ model: visualSettings.model }).from(visualSettings).where(eq(visualSettings.id, 1)).limit(1);
  const [personal] = ownerId ? await db.select().from(aiSettings).where(eq(aiSettings.id, ownerId)).limit(1) : [];
  const provider = PROVIDERS[personal?.visualProvider ?? "pollinations"];
  const accountSource = personal?.visualAccountSource ?? "application";
  const connected = Boolean(provider.id === "openrouter" ? personal?.openrouterKey : personal?.pollinationsKey);
  const expired = provider.id === "pollinations" && Boolean(personal?.pollinationsKeyExpiresAt && personal.pollinationsKeyExpiresAt.getTime() <= Date.now());
  const applicationAvailable = provider.id === "pollinations" && base.authenticated;
  const model = provider.id === "openrouter" ? personal?.visualModel || provider.defaultModel
    : accountSource === "personal" ? personal?.visualModel || personal?.pollinationsImageModel || base.model : saved?.model ?? base.model;
  return { ...base, enabled: base.enabled && (personal?.visualEnabled ?? true), provider, accountSource, model,
    endpoint: provider.id === "openrouter" ? personal?.visualEndpoint ?? null : null,
    availableAccounts: { application: applicationAvailable, personal: connected && !expired },
    authenticated: accountSource === "personal" ? connected && !expired : applicationAvailable };
}

function visualPreferencesView(row: Awaited<ReturnType<typeof getRawSettingsRow>>, application: Awaited<ReturnType<typeof readVisualConfig>>) {
  return { enabled: row.visualEnabled, provider: row.visualProvider, endpoint: row.visualEndpoint,
    accountSource: row.visualAccountSource, model: row.visualModel || (row.visualProvider === "pollinations" ? row.pollinationsImageModel : "") || PROVIDERS[row.visualProvider].defaultModel,
    applicationModel: application.model, applicationConfigured: application.authenticated,
    pollinationsConfigured: Boolean(row.pollinationsKey), openrouterConfigured: Boolean(row.openrouterKey),
    ...(row.pollinationsKeyExpiresAt ? { expiresAt: row.pollinationsKeyExpiresAt.toISOString() } : {}) };
}

export async function getVisualPreferences(ownerId: string) {
  const [row, application] = await Promise.all([getRawSettingsRow(ownerId), readVisualConfig()]);
  return visualPreferencesView(row, application);
}

export async function saveVisualPreferences(ownerId: string, body: Record<string, unknown>, options: { authorize?: () => Promise<unknown> } = {}) {
  const input = parseVisualPreferences(body);
  if (input.enabled) await assertVisualGenerationSelection(input.provider, input.model, input.endpoint);
  await getRawSettingsRow(ownerId);
  // Catalogue I/O can outlive the session that admitted an HTTP mutation.
  await options.authorize?.();
  const [saved] = await db.update(aiSettings).set({ visualEnabled: input.enabled, visualProvider: input.provider, visualModel: input.model, visualEndpoint: input.endpoint,
    visualAccountSource: input.accountSource, ...(input.provider === "pollinations" ? { pollinationsImageModel: input.model } : {}), updatedAt: new Date() }).where(eq(aiSettings.id, ownerId)).returning();
  if (!saved) throw new HttpError(409, "SETTINGS_CHANGED", "Настройки изменились во время сохранения. Повторите попытку.");
  return visualPreferencesView(saved, await readVisualConfig());
}

/** Resolve only the recorded payer. A missing personal key never spends application funds. */
export async function visualCredential(ownerId: string | null, accountSource: VisualAccountSource, provider: string = "pollinations"): Promise<string> {
  if (provider !== "pollinations" && provider !== "openrouter") throw new HttpError(503, "VISUAL_PROVIDER_UNCONFIGURED", "Сервис иллюстраций недоступен.");
  if (accountSource === "application") {
    if (provider === "openrouter") throw new HttpError(503, "VISUAL_PROVIDER_UNCONFIGURED", "Для иллюстраций OpenRouter подключите личный аккаунт.");
    const key = process.env.POLLINATIONS_API_KEY?.trim();
    if (!key) throw new HttpError(503, "VISUAL_PROVIDER_UNCONFIGURED", "Аккаунт приложения Pollinations не настроен. Выберите личный аккаунт в настройках.");
    return key;
  }
  const [row] = ownerId ? await db.select().from(aiSettings).where(eq(aiSettings.id, ownerId)).limit(1) : [];
  if (provider === "openrouter") {
    if (!row?.openrouterKey) throw new HttpError(503, "OPENROUTER_CONNECTION_REQUIRED", "Подключите личный аккаунт OpenRouter в настройках.");
    return openSecret(row.openrouterKey, secretContext(row.id, "text:openrouter"));
  }
  if (!row?.pollinationsKey || (row.pollinationsKeyExpiresAt && row.pollinationsKeyExpiresAt.getTime() <= Date.now())) {
    throw new HttpError(503, "POLLINATIONS_CONNECTION_REQUIRED", "Подключите личный аккаунт Pollinations заново в настройках.");
  }
  return openSecret(row.pollinationsKey, secretContext(row.id, "text:pollinations"));
}

export async function saveVisualModel(model: string, adminAccountId: string): Promise<void> {
  await db.insert(visualSettings).values({ id: 1, model, updatedBy: adminAccountId })
    .onConflictDoUpdate({ target: visualSettings.id, set: { model, updatedBy: adminAccountId, updatedAt: new Date() } });
}
