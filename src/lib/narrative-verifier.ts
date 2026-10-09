import type { NarrativeCheckSelection, NarrativeVerdict } from "./narrative-policy";
import { JEV_PROVIDERS, runJevTask, summarizeJevOutcome, type JevOutcome, type JevProvider, type JevTask, type JevTransport } from "./jev-tasks";

export type NarrativeProvider = JevProvider;
export const NARRATIVE_PROVIDERS = JEV_PROVIDERS;
export type NarrativeAnswer = { choice: NarrativeVerdict; confidence: number; probabilities: Record<NarrativeVerdict, number> };
export type NarrativeVerification = {
  status: "verified" | "rejected" | "uncertain" | "unavailable" | "skipped";
  provider: NarrativeProvider; model: string; latencyMs: number;
  reason?: string; answers: Record<string, NarrativeAnswer>;
  usage?: { inputTokens: number; outputTokens: number; cost?: number };
};

export const NARRATIVE_TASK_ID = "narrative-consistency" as const;
export const NARRATIVE_TASK_VERSION = "2026-10-09-final-canon-notes-v2" as const;
const NARRATIVE_LABELS: readonly NarrativeVerdict[] = ["consistent", "contradicts", "insufficient"];
/** Консервативные стартовые пороги, не измеренная калибровка. */
const NARRATIVE_POLICY = { insufficientLabel: "insufficient" as const, acceptLabel: "consistent" as const, rejectLabel: "contradicts" as const, minConfidence: 0.8, minProbability: 0.9 };

/** JEV-3a: адаптер существующей проверки повествования к общему контракту заданий. */
export function narrativeJevTask(selection: NarrativeCheckSelection, state: Record<string, unknown>, snapshotVersion?: string | number): JevTask<NarrativeVerdict> {
  return {
    taskId: NARRATIVE_TASK_ID, taskVersion: NARRATIVE_TASK_VERSION, labels: NARRATIVE_LABELS, uncertainty: NARRATIVE_POLICY,
    state, questions: selection.questions, strictProbabilities: true, limits: { maxQuestions: 12, maxBodyBytes: 100_000 },
    ...(snapshotVersion !== undefined ? { snapshotVersion } : {}),
  };
}

export function narrativeVerificationFromOutcome(outcome: JevOutcome<NarrativeVerdict>): NarrativeVerification {
  const base = { provider: outcome.provider, model: outcome.model, answers: outcome.answers, latencyMs: outcome.latencyMs };
  if (outcome.status !== "answered") return { ...base, status: "unavailable", reason: outcome.reason ?? "request_failed" };
  const summary = summarizeJevOutcome(outcome, NARRATIVE_POLICY);
  const status = summary === "reject" ? "rejected" : summary === "accept" ? "verified" : "uncertain";
  return { ...base, status, ...(outcome.usage ? { usage: outcome.usage } : {}) };
}

/** Narrow checks only. Thresholds are conservative initial policy, not measured calibration. */
export async function verifyNarrative(input: {
  selection: NarrativeCheckSelection; state: Record<string, unknown>; apiKey: string;
  provider?: NarrativeProvider; timeoutMs?: number; fetchImpl?: typeof fetch; transport?: JevTransport; snapshotVersion?: string | number;
}): Promise<NarrativeVerification> {
  const provider = input.provider ?? "typesafe";
  if (!input.selection.required) return { provider, model: JEV_PROVIDERS[provider].model, answers: {}, latencyMs: 0, status: "skipped" };
  const outcome = await runJevTask(narrativeJevTask(input.selection, input.state, input.snapshotVersion), {
    apiKey: input.apiKey, provider, timeoutMs: input.timeoutMs ?? 2500, maxTimeoutMs: 5000, fetchImpl: input.fetchImpl, transport: input.transport,
  });
  return narrativeVerificationFromOutcome(outcome);
}
