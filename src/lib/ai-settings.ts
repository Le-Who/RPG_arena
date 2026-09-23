// ── Единый доступ к настройкам ИИ (ключи, роутинг, лимиты, эмбеддинги) ──
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { aiSettings, tokenLogs } from "@/db/schema";
import { filterByDailyLimits, routeModelsFor, type RoutingConfig, type TaskType } from "./gemini";
import { currentProfileId } from "./identity";
import { sessionOwnerId } from "./campaign-access";
import { DEFAULT_EMBEDDING_DIMS } from "./embeddings";
import { decodeGeminiSecrets, decodeSettingsSecrets, sealSecret, secretContext, type SecretKeyring } from "./secret-vault";
import { quotaUsage, quotaTimezone } from "./quota";

export type AIConfig = {
  ownerId?: string;
  keys: string[];
  dbKeyCount: number;
  envKeyCount: number;
  useLiveAI: boolean;
  canUseLive: boolean;
  routingConfig: RoutingConfig;
  limits: { flash: number; lite: number };
  enforceLimits: boolean;
  keysSharedProject?: boolean;
  dailyEmbeddingLimit?: number;
  embeddingsEnabled: boolean;
  embeddingModel: string;
  embeddingDims: number;
  semanticExtractionEnabled: boolean;
};

const DEFAULT_ROW = {
  keys: [] as string[],
  useLiveAI: false,
  routingProfile: "balanced",
  narrationModel: "gemini-3.5-flash-lite",
  customActionModel: "gemini-3.8-flash",
  compactionModel: "gemini-3.8-flash",
  fastTaskModel: "gemini-3.5-flash-lite",
};

export async function getSettingsRow(ownerId?: string) {
  return decodeSettingsSecrets(await getRawSettingsRow(ownerId));
}

export async function getRawSettingsRow(ownerId?: string) {
  const id = ownerId ?? await currentProfileId();
  const rows = await db.select().from(aiSettings).where(eq(aiSettings.id, id));
  if (rows[0]) return rows[0];
  await db.insert(aiSettings).values({ ...DEFAULT_ROW, id }).onConflictDoNothing();
  const fresh = await db.select().from(aiSettings).where(eq(aiSettings.id, id));
  if (!fresh[0]) throw new Error("Settings row was not created");
  return fresh[0];
}

export function prepareGeminiKeysWrite(ownerId: string, keys: string[], keyring?: SecretKeyring): string[] {
  return keys.map(key => sealSecret(key, secretContext(ownerId, "gemini"), keyring));
}

export async function getAIConfig(ownerId?: string): Promise<AIConfig> {
  quotaTimezone();
  const s = decodeGeminiSecrets(await getRawSettingsRow(ownerId));
  const dbKeys = ((s.keys as string[]) ?? []).filter(Boolean);
  const keys = [...new Set(dbKeys)];
  return {
    ownerId: s.id,
    keys,
    dbKeyCount: dbKeys.length,
    envKeyCount: 0,
    useLiveAI: s.useLiveAI,
    canUseLive: s.useLiveAI && keys.length > 0,
    routingConfig: {
      profile: (s.routingProfile as RoutingConfig["profile"]) ?? "balanced",
      narrationModel: s.narrationModel ?? DEFAULT_ROW.narrationModel,
      customActionModel: s.customActionModel ?? DEFAULT_ROW.customActionModel,
      compactionModel: s.compactionModel ?? DEFAULT_ROW.compactionModel,
      fastTaskModel: s.fastTaskModel ?? DEFAULT_ROW.fastTaskModel,
    },
    limits: { flash: s.dailyFlashLimit ?? 20, lite: s.dailyLiteLimit ?? 500 },
    enforceLimits: s.enforceLimits ?? true,
    keysSharedProject: s.keysSharedProject ?? true,
    dailyEmbeddingLimit: s.dailyEmbeddingLimit ?? 5000,
    embeddingsEnabled: s.embeddingsEnabled ?? true,
    embeddingModel: "gemini-embedding-2",
    embeddingDims: s.embeddingDims || DEFAULT_EMBEDDING_DIMS,
    semanticExtractionEnabled: s.semanticExtractionEnabled ?? true,
  };
}

/** Число вызовов генеративных моделей сегодня (успешных и неуспешных — квота тратится в обоих случаях). */
export async function todayUsageByModel(ownerId?: string): Promise<Record<string, number>> {
  return quotaUsage(ownerId ?? await currentProfileId());
}

/** Модели для задачи с учётом роутинга и (если включено) дневных лимитов. */
export async function pickModels(task: TaskType, cfg: AIConfig): Promise<{ models: string[]; skipped: string[] }> {
  const routed = routeModelsFor(task, cfg.routingConfig);
  if (!cfg.enforceLimits) return { models: routed, skipped: [] };
  const usage = await todayUsageByModel(cfg.ownerId);
  const { allowed, skipped } = filterByDailyLimits(routed, usage, cfg.limits, cfg.keysSharedProject === false ? cfg.keys.length : 1);
  return { models: allowed, skipped };
}

export async function logToken(row: {
  sessionId: string | null;
  model: string;
  taskType: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  success: boolean;
  error?: string;
  keyIndex?: number;
}) {
  try {
    await db.insert(tokenLogs).values({
      ownerId: row.sessionId ? await sessionOwnerId(row.sessionId) : await currentProfileId(),
      sessionId: row.sessionId,
      model: row.model,
      quotaReserved: row.model.startsWith("gemini-"),
      taskType: row.taskType,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      totalTokens: row.promptTokens + row.completionTokens,
      latencyMs: row.latencyMs,
      success: row.success,
      error: row.error ?? "",
      keyIndex: row.keyIndex ?? 0,
    });
  } catch {
    /* логирование не должно ломать ход */
  }
}
