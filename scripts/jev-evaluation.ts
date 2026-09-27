/** Offline evaluation helpers. Never imported by the game runtime. */
import { isAllowedJevModel } from "../src/lib/jev-tasks";
export type PrimitiveQuestion = { type: "score"; instructions: string; criteria: string[] } | { type: "noul"; instructions: string; criteria?: { true: string; false: string } } | { type: "choice"; instructions: string; criteria: Record<string, string> };
type Answer = { noul?: number; score?: number; choice?: string; confidence?: number; probabilities?: Record<string, number> };
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const probability = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const invalid = (): never => { throw new Error("invalid_response"); };
export function parsePrimitiveAnswers(raw: unknown, questions: Record<string, PrimitiveQuestion>) {
  if (!record(raw) || !isAllowedJevModel("openrouter", raw.model) || !record(raw.answers) || !record(raw.usage)) return invalid();
  const answers: Record<string, Answer> = {};
  if (Object.keys(raw.answers).length !== Object.keys(questions).length) return invalid();
  for (const [id, q] of Object.entries(questions)) {
    const a = Object.hasOwn(raw.answers, id) ? raw.answers[id] : undefined;
    if (!record(a) || a.type !== q.type) return invalid();
    if (q.type === "noul") {
      if (!probability(a.noul)) return invalid();
      answers[id] = { noul: a.noul };
      continue;
    }
    if (!probability(a.confidence) || !record(a.probabilities)) return invalid();
    const labels = Object.keys(q.criteria), p = a.probabilities;
    if (Object.keys(p).length !== labels.length || !labels.every(k => Object.hasOwn(p, k) && probability(p[k]))) return invalid();
    const probabilities = Object.fromEntries(labels.map(k => [k, p[k] as number]));
    if (Math.abs(Object.values(probabilities).reduce((a, b) => a + b, 0) - 1) > .011) return invalid();
    if (q.type === "choice") {
      if (typeof a.choice !== "string" || !labels.includes(a.choice) || probabilities[a.choice] + .000001 < Math.max(...Object.values(probabilities))) return invalid();
      answers[id] = { choice: a.choice, confidence: a.confidence, probabilities };
    } else {
      const mean = labels.reduce((sum, k) => sum + Number(k) * probabilities[k], 0);
      // Provider probabilities are rounded; do not silently recompute its score.
      if (typeof a.score !== "number" || !Number.isFinite(a.score) || a.score < 0 || a.score > labels.length - 1 || Math.abs(a.score - mean) > .03) return invalid();
      answers[id] = { score: a.score, confidence: a.confidence, probabilities };
    }
  }
  const u = raw.usage;
  if (![u.input_tokens, u.output_tokens].every(v => typeof v === "number" && Number.isSafeInteger(v) && v >= 0)) return invalid();
  if (u.cost !== undefined && (typeof u.cost !== "number" || !Number.isFinite(u.cost) || u.cost < 0)) return invalid();
  return { model: raw.model, answers, usage: { inputTokens: u.input_tokens as number, outputTokens: u.output_tokens as number, ...(typeof u.cost === "number" ? { cost: u.cost } : {}) } };
}

export function selectiveMetrics(rows: { expected: string; status: string }[]) {
  const checked = rows.filter(r => r.status !== "skipped");
  const accepted = rows.filter(r => r.status === "verified");
  const decided = rows.filter(r => r.status === "verified" || r.status === "rejected");
  const falseAccepts = accepted.filter(r => r.expected !== "consistent").length;
  const wrong = decided.filter(r => r.status === "verified" ? r.expected !== "consistent" : r.expected !== "contradicts").length;
  const ratio = (a: number, b: number) => b ? a / b : null;
  const wilson = (errors: number, n: number): [number, number] | null => {
    if (!n) return null;
    const z = 1.96, p = errors / n, d = 1 + z * z / n;
    const center = (p + z * z / (2 * n)) / d;
    const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
    return [Math.max(0, center - half), Math.min(1, center + half)];
  };
  return { total: rows.length, checked: checked.length, accepted: accepted.length, decided: decided.length, falseAccepts,
    modelDecisionCoverage: ratio(decided.length, checked.length), selectiveErrorRate: ratio(wrong, decided.length),
    acceptedErrorRate: ratio(falseAccepts, accepted.length), acceptedError95Wilson: wilson(falseAccepts, accepted.length),
    uncertain: rows.filter(r => r.status === "uncertain").length, unavailable: rows.filter(r => r.status === "unavailable").length,
    unchecked: rows.filter(r => r.status === "skipped").length,
    uncheckedBad: rows.filter(r => r.status === "skipped" && r.expected !== "consistent").length };
}

export function rankMetrics(grades: number[], scores: number[]) {
  if (!grades.length || grades.length !== scores.length || !scores.every(Number.isFinite)) throw new Error("invalid_ranking");
  const ranked = scores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s || a.i - b.i);
  const direct = grades.filter(g => g === 2).length;
  return { top1Direct: grades[ranked[0].i] === 2 ? 1 : 0, directRecallAt2: direct ? ranked.slice(0, 2).filter(r => grades[r.i] === 2).length / direct : null };
}
