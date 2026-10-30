import type { getRawSettingsRow } from "./ai-settings";
import { secretStorageAvailable } from "./secret-vault";
import { settingsCredentialsView } from "./settings-credentials-view";
import { EMBEDDING_MODEL_ALIASES } from "./embeddings";
import { ROUTING_PROFILES } from "./gemini";

export function settingsView(s: Awaited<ReturnType<typeof getRawSettingsRow>>) {
  const { keysMasked, credentialIssues } = settingsCredentialsView(s);
  const textProvider = s.textProvider ?? "gemini";
  const pollinationsKeyExpired = Boolean(s.pollinationsKeyExpiresAt && s.pollinationsKeyExpiresAt.getTime() <= Date.now());
  const canUseLive = s.useLiveAI && !credentialIssues.some(provider => provider === textProvider)
    && (textProvider === "gemini" ? keysMasked.length > 0
    : Boolean(s.textModel && (textProvider === "openrouter" ? s.openrouterKey : textProvider === "pollinations" && s.pollinationsKey && !pollinationsKeyExpired)));
  return {
    secretStorageAvailable: secretStorageAvailable(),
    keysMasked,
    keysCount: keysMasked.length,
    ...(credentialIssues.length ? { credentialIssues } : {}),
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
