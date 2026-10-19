import type { getRawSettingsRow } from "./ai-settings";
import { decodeGeminiSecrets, secretStorageAvailable } from "./secret-vault";
import { EMBEDDING_MODEL_ALIASES } from "./embeddings";
import { ROUTING_PROFILES } from "./gemini";

function mask(keys: string[]) {
  return keys.map((k) => (k.length <= 8 ? "••••" : `${k.slice(0, 4)}••••${k.slice(-4)}`));
}

export function settingsView(raw: Awaited<ReturnType<typeof getRawSettingsRow>>) {
  const s = decodeGeminiSecrets(raw);
  const keys = ((s.keys as string[]) ?? []).filter(Boolean);
  const textProvider = s.textProvider ?? "gemini";
  const pollinationsKeyExpired = Boolean(s.pollinationsKeyExpiresAt && s.pollinationsKeyExpiresAt.getTime() <= Date.now());
  const canUseLive = s.useLiveAI && (textProvider === "gemini" ? keys.length > 0
    : Boolean(s.textModel && (textProvider === "openrouter" ? s.openrouterKey : textProvider === "pollinations" && s.pollinationsKey && !pollinationsKeyExpired)));
  return {
    secretStorageAvailable: secretStorageAvailable(),
    keysMasked: mask(keys),
    keysCount: keys.length,
    envKeysCount: 0,
    textProvider,
    textModel: s.textModel ?? "",
    canUseLive,
    ...(textProvider === "pollinations" && s.pollinationsKeyExpiresAt ? { textKeyExpiresAt: s.pollinationsKeyExpiresAt.toISOString() } : {}),
    routingProfile: s.routingProfile ?? "balanced",
    narrationModel: s.narrationModel,
    customActionModel: s.customActionModel,
    compactionModel: s.compactionModel,
    fastTaskModel: s.fastTaskModel,
    useLiveAI: s.useLiveAI,
    dailyFlashLimit: s.dailyFlashLimit,
    dailyLiteLimit: s.dailyLiteLimit,
    keysSharedProject: s.keysSharedProject,
    dailyEmbeddingLimit: s.dailyEmbeddingLimit,
    enforceLimits: s.enforceLimits,
    embeddingsEnabled: s.embeddingsEnabled,
    embeddingModel: s.embeddingModel,
    embeddingDims: s.embeddingDims,
    semanticExtractionEnabled: s.semanticExtractionEnabled,
    embeddingModels: EMBEDDING_MODEL_ALIASES,
    profiles: ROUTING_PROFILES,
  };
}
