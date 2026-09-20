import type { NarrativeCheckSelection, NarrativeVerdict } from "./narrative-policy";

export type NarrativeProvider = "typesafe" | "openrouter";
export const NARRATIVE_PROVIDERS = {
  typesafe: { endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-1.13.0" },
  openrouter: { endpoint: "https://openrouter.ai/api/alpha/decisions", model: "typesafe/jev-1.13" },
} as const;
export type NarrativeAnswer = { choice: NarrativeVerdict; confidence: number; probabilities: Record<NarrativeVerdict, number> };
export type NarrativeVerification = {
  status: "verified" | "rejected" | "uncertain" | "unavailable" | "skipped";
  provider: NarrativeProvider; model: string; latencyMs: number;
  reason?: string; answers: Record<string, NarrativeAnswer>;
  usage?: { inputTokens: number; outputTokens: number; cost?: number };
};

const labels: NarrativeVerdict[] = ["consistent", "contradicts", "insufficient"];
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const probability = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const tokens = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
function parse(raw: unknown, ids: string[], provider: NarrativeProvider) {
  if (!record(raw) || typeof raw.model !== "string" || !record(raw.answers) || !record(raw.usage)) throw new Error("invalid_response");
  const validModel = provider === "typesafe" ? raw.model === "jev-1.13.0" : /^(?:typesafe\/)?jev-1\.13(?:\.0)?(?:-\d{4}-?\d{2}-?\d{2})?$/.test(raw.model);
  if (!validModel || Object.keys(raw.answers).length !== ids.length) throw new Error("invalid_response");
  const answers: Record<string, NarrativeAnswer> = {};
  for (const id of ids) {
    const a = raw.answers[id];
    if (!record(a) || a.type !== "choice" || !labels.includes(a.choice as NarrativeVerdict) || !probability(a.confidence) || !record(a.probabilities)) throw new Error("invalid_response");
    const p = a.probabilities;
    if (Object.keys(p).length !== labels.length || !labels.every(label => probability(p[label]))) throw new Error("invalid_response");
    const probabilities = p as Record<NarrativeVerdict, number>;
    if (Math.abs(labels.reduce((s, label) => s + probabilities[label], 0) - 1) > .01) throw new Error("invalid_response");
    const choice = a.choice as NarrativeVerdict;
    if (probabilities[choice] + 1e-6 < Math.max(...Object.values(probabilities))) throw new Error("invalid_response");
    answers[id] = { choice, confidence: a.confidence, probabilities };
  }
  if (!tokens(raw.usage.input_tokens) || !tokens(raw.usage.output_tokens)) throw new Error("invalid_response");
  const cost = raw.usage.cost;
  if (cost !== undefined && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)) throw new Error("invalid_response");
  return { model: raw.model, answers, usage: { inputTokens: raw.usage.input_tokens, outputTokens: raw.usage.output_tokens, ...(typeof cost === "number" ? { cost } : {}) } };
}

/** Narrow checks only. Thresholds are conservative initial policy, not measured calibration. */
export async function verifyNarrative(input: {
  selection: NarrativeCheckSelection; state: Record<string, unknown>; apiKey: string;
  provider?: NarrativeProvider; timeoutMs?: number; fetchImpl?: typeof fetch;
}): Promise<NarrativeVerification> {
  const provider = input.provider ?? "typesafe";
  const config = NARRATIVE_PROVIDERS[provider];
  const base = { provider, model: config.model, answers: {}, latencyMs: 0 };
  if (!input.selection.required) return { ...base, status: "skipped" };
  if (!input.apiKey.trim()) return { ...base, status: "unavailable", reason: "missing_key" };
  const ids = Object.keys(input.selection.questions);
  if (!ids.length || ids.length > 12) return { ...base, status: "unavailable", reason: "question_coverage" };
  let body: string;
  try { body = JSON.stringify({ model: config.model, state: input.state, questions: input.selection.questions }); }
  catch { return { ...base, status: "unavailable", reason: "invalid_input" }; }
  // No silent truncation: unknown coverage is not a verified result.
  if (body.length > 100_000) return { ...base, status: "unavailable", reason: "input_too_large" };
  const controller = new AbortController();
  const started = performance.now();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, Math.min(5000, input.timeoutMs ?? 2500)));
  try {
    const res = await (input.fetchImpl ?? fetch)(config.endpoint, { method: "POST", redirect: "error", headers: { Authorization: `Bearer ${input.apiKey.trim()}`, "Content-Type": "application/json" }, body, signal: controller.signal });
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw new Error("provider_error"); }
    const parsed = parse(await res.json(), ids, provider);
    const values = Object.values(parsed.answers);
    const status = values.some(a => a.choice === "contradicts" && a.confidence >= .8 && a.probabilities.contradicts >= .9) ? "rejected"
      : values.every(a => a.choice === "consistent" && a.confidence >= .8 && a.probabilities.consistent >= .9) ? "verified" : "uncertain";
    return { ...base, ...parsed, status, latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    const reason = controller.signal.aborted ? "timeout" : error instanceof Error && ["invalid_response", "provider_error"].includes(error.message) ? error.message : "request_failed";
    return { ...base, status: "unavailable", reason, latencyMs: Math.round(performance.now() - started) };
  } finally { clearTimeout(timeout); }
}
