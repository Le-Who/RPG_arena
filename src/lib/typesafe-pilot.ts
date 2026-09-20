import type { ExtractedFact } from "./memory";
import { TYPE_SAFE_MODEL, TYPE_SAFE_PROMPT_VERSION, verifyTypeSafeFacts } from "./typesafe";
import type { TypeSafeReport } from "./typesafe-report";

export type TypeSafePilotConfig = {
  enabled: boolean;
  apiKey: string;
  source: "env" | "stored" | "none";
};

const errorReport = (message: string): TypeSafeReport => ({
  status: "error",
  model: TYPE_SAFE_MODEL,
  promptVersion: TYPE_SAFE_PROMPT_VERSION,
  evaluations: [],
  usage: null,
  latencyMs: 0,
  error: message,
});

export async function runTypeSafePilotSafely(input: {
  facts: ExtractedFact[];
  narration: string;
  playerAction: string;
  loadConfig: () => Promise<TypeSafePilotConfig>;
  verify?: typeof verifyTypeSafeFacts;
}): Promise<TypeSafeReport> {
  let config: TypeSafePilotConfig;
  try {
    config = await input.loadConfig();
  } catch {
    return errorReport("Не удалось прочитать настройки TypeSafe.");
  }
  const baseInput = { facts: input.facts, narration: input.narration, playerAction: input.playerAction };
  if (!config.enabled) return verifyTypeSafeFacts({ ...baseInput, enabled: false, apiKey: config.apiKey });
  if (!config.apiKey.trim()) return verifyTypeSafeFacts({ ...baseInput, enabled: true, apiKey: "" });
  if (!input.facts.length) return verifyTypeSafeFacts({ ...baseInput, enabled: true, apiKey: config.apiKey });
  try {
    return await (input.verify ?? verifyTypeSafeFacts)({
      enabled: true,
      apiKey: config.apiKey,
      facts: input.facts,
      narration: input.narration,
      playerAction: input.playerAction,
    });
  } catch {
    return errorReport("Не удалось проверить факты через TypeSafe.");
  }
}
