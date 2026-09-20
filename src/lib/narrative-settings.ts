import { HttpError } from "./http";
import { NARRATIVE_PROVIDERS, type NarrativeProvider } from "./narrative-verifier";

type CredentialSource = "personal" | "administrator" | "none";
export type NarrativeGuardConfig = { enabled: boolean; provider: NarrativeProvider; apiKey: string; requestedEnabled?: boolean; credentialSource?: CredentialSource };
type AdministratorCredential = { provider: NarrativeProvider; apiKey: string };
type SettingsRow = { narrativeGuardEnabled?: boolean; narrativeGuardProvider?: string; narrativeGuardKey?: string; [key: string]: unknown };
export type NarrativeSettingsView = { enabled: boolean; active: boolean; provider: NarrativeProvider; configured: boolean; maskedKey: string | null; model: string; credentialSource: CredentialSource; administratorAvailable: boolean };
export type NarrativeSettingsUpdate = { enabled?: boolean; provider?: NarrativeProvider; key?: string; clearKey?: boolean };

export function resolveNarrativeGuardConfig(row: SettingsRow, administrator?: AdministratorCredential): NarrativeGuardConfig {
  const validProvider = row.narrativeGuardProvider === "typesafe" || row.narrativeGuardProvider === "openrouter";
  const personalKey = validProvider ? row.narrativeGuardKey?.trim() ?? "" : "";
  const adminKey = administrator?.apiKey.trim() ?? "";
  const apiKey = personalKey || adminKey;
  const requestedEnabled = row.narrativeGuardEnabled ?? true;
  return {
    enabled: requestedEnabled && Boolean(apiKey), requestedEnabled,
    provider: personalKey ? row.narrativeGuardProvider as NarrativeProvider : adminKey ? administrator!.provider : "openrouter",
    // An invalid stored provider must never send its credentials to the default provider.
    apiKey, credentialSource: personalKey ? "personal" : adminKey ? "administrator" : "none",
  };
}

export function narrativeSettingsView(row: SettingsRow, administrator?: AdministratorCredential): NarrativeSettingsView {
  const config = resolveNarrativeGuardConfig(row, administrator);
  const personal = resolveNarrativeGuardConfig(row);
  const provider = row.narrativeGuardProvider === "typesafe" ? "typesafe" : "openrouter";
  return { enabled: config.requestedEnabled!, active: config.enabled, provider, configured: Boolean(personal.apiKey),
    maskedKey: personal.apiKey ? `••••${personal.apiKey.slice(-4)}` : null, model: NARRATIVE_PROVIDERS[config.provider].model,
    credentialSource: config.credentialSource!, administratorAvailable: Boolean(administrator?.apiKey.trim()) };
}

function administratorCredential(): AdministratorCredential | undefined {
  const openrouter = process.env.NARRATIVE_ADMIN_OPENROUTER_API_KEY?.trim();
  if (openrouter) return { provider: "openrouter", apiKey: openrouter };
  const typesafe = process.env.NARRATIVE_ADMIN_TYPESAFE_API_KEY?.trim();
  return typesafe ? { provider: "typesafe", apiKey: typesafe } : undefined;
}

export function parseNarrativeSettingsUpdate(input: Record<string, unknown>): NarrativeSettingsUpdate {
  const invalid = () => new HttpError(400, "INVALID_INPUT", "Некорректные настройки проверки повествования.");
  if (Object.keys(input).some(key => !["enabled", "provider", "key", "clearKey"].includes(key))) throw invalid();
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw invalid();
  if (input.clearKey !== undefined && typeof input.clearKey !== "boolean") throw invalid();
  if (input.provider !== undefined && input.provider !== "typesafe" && input.provider !== "openrouter") throw invalid();
  if (input.key !== undefined && (typeof input.key !== "string" || input.key.trim().length < 12 || input.key.trim().length > 500 || /[\u0000-\u0020\u007f]/.test(input.key.trim()))) {
    throw new HttpError(400, "INVALID_KEY", "Ключ должен содержать от 12 до 500 символов без пробелов и переносов строк.");
  }
  if (input.clearKey === true && input.key !== undefined) throw invalid();
  return input as NarrativeSettingsUpdate;
}

export function narrativeSettingsPatch(row: SettingsRow, input: NarrativeSettingsUpdate) {
  const patch: { narrativeGuardEnabled?: boolean; narrativeGuardProvider?: NarrativeProvider; narrativeGuardKey?: string } = {};
  if (input.enabled !== undefined) patch.narrativeGuardEnabled = input.enabled;
  if (input.provider !== undefined) {
    patch.narrativeGuardProvider = input.provider;
    if (input.provider !== row.narrativeGuardProvider) patch.narrativeGuardKey = "";
  }
  if (input.clearKey) patch.narrativeGuardKey = "";
  if (input.key !== undefined) patch.narrativeGuardKey = input.key.trim();
  return patch;
}

export async function getNarrativeGuardConfig(ownerId?: string): Promise<NarrativeGuardConfig> {
  const { getSettingsRow } = await import("./ai-settings");
  return resolveNarrativeGuardConfig(await getSettingsRow(ownerId), administratorCredential());
}

export async function getNarrativeSettingsView(): Promise<NarrativeSettingsView> {
  const { currentProfileId } = await import("./identity");
  const ownerId = await currentProfileId();
  const { getSettingsRow } = await import("./ai-settings");
  return narrativeSettingsView(await getSettingsRow(ownerId), administratorCredential());
}

export async function updateNarrativeSettings(raw: Record<string, unknown>): Promise<NarrativeSettingsView> {
  const { currentProfileId } = await import("./identity");
  const ownerId = await currentProfileId();
  const input = parseNarrativeSettingsUpdate(raw);
  const { getSettingsRow } = await import("./ai-settings");
  await getSettingsRow(ownerId);
  const { db } = await import("@/db");
  const { aiSettings } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  // Serialize provider/key updates so concurrent requests cannot mix provider credentials.
  return db.transaction(async tx => {
    const [row] = await tx.select().from(aiSettings).where(eq(aiSettings.id, ownerId)).for("update");
    const [saved] = await tx.update(aiSettings).set({ ...narrativeSettingsPatch(row, input), updatedAt: new Date() }).where(eq(aiSettings.id, ownerId)).returning();
    return narrativeSettingsView(saved, administratorCredential());
  });
}
