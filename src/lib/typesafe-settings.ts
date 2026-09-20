import { eq } from "drizzle-orm";
import { db } from "@/db";
import { aiSettings } from "@/db/schema";
import { getSettingsRow } from "./ai-settings";
import type { TypeSafePilotConfig } from "./typesafe-pilot";

export type TypeSafeSettingsView = {
  configured: boolean;
  storedConfigured: boolean;
  maskedKey: string | null;
  source: TypeSafePilotConfig["source"];
  envOverride: boolean;
  pilotEnabled: boolean;
  model: "jev-1.13.0";
};

export function resolveTypeSafeKey(stored: string | null | undefined, environment: string | null | undefined): Pick<TypeSafePilotConfig, "apiKey" | "source"> {
  const envKey = environment?.trim() ?? "";
  if (envKey) return { apiKey: envKey, source: "env" };
  const storedKey = stored?.trim() ?? "";
  if (storedKey) return { apiKey: storedKey, source: "stored" };
  return { apiKey: "", source: "none" };
}

export function maskTypeSafeKey(key: string): string {
  const trimmed = key.trim();
  return trimmed.length > 8 ? `••••${trimmed.slice(-4)}` : "••••";
}

export async function getTypeSafePilotConfig(ownerId?: string): Promise<TypeSafePilotConfig> {
  const row = await getSettingsRow(ownerId);
  const resolved = resolveTypeSafeKey(row.typesafeKey, undefined);
  return { enabled: row.typesafePilotEnabled ?? false, ...resolved };
}

export async function getTypeSafeSettingsView(): Promise<TypeSafeSettingsView> {
  const row = await getSettingsRow();
  const resolved = resolveTypeSafeKey(row.typesafeKey, undefined);
  return {
    configured: Boolean(resolved.apiKey),
    storedConfigured: Boolean(row.typesafeKey?.trim()),
    maskedKey: resolved.apiKey ? maskTypeSafeKey(resolved.apiKey) : null,
    source: resolved.source,
    envOverride: resolved.source === "env",
    pilotEnabled: row.typesafePilotEnabled ?? false,
    model: "jev-1.13.0",
  };
}

export async function updateTypeSafeSettings(input: { key?: string; clearKey?: boolean; pilotEnabled?: boolean }): Promise<TypeSafeSettingsView> {
  const row = await getSettingsRow();
  let key = row.typesafeKey ?? "";
  if (input.clearKey) key = "";
  if (input.key !== undefined) key = input.key.trim();
  await db.update(aiSettings).set({
    typesafeKey: key,
    typesafePilotEnabled: input.pilotEnabled ?? row.typesafePilotEnabled ?? false,
    updatedAt: new Date(),
  }).where(eq(aiSettings.id, row.id));
  return getTypeSafeSettingsView();
}
