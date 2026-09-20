import type { TypeSafeVerdict } from "./typesafe-report";

const LABELS: TypeSafeVerdict[] = ["supports", "contradicts", "unsupported"];

export type TypeSafeEvalOutcome = {
  expected: TypeSafeVerdict;
  actual: TypeSafeVerdict | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
};

export function scoreTypeSafeEvaluations(outcomes: TypeSafeEvalOutcome[]) {
  const confusion = Object.fromEntries(LABELS.map((expected) => [expected, Object.fromEntries(LABELS.map((actual) => [actual, 0]))])) as Record<TypeSafeVerdict, Record<TypeSafeVerdict, number>>;
  let correct = 0;
  let errors = 0;
  let latency = 0;
  let input = 0;
  let output = 0;
  for (const item of outcomes) {
    latency += item.latencyMs;
    input += item.inputTokens;
    output += item.outputTokens;
    if (item.actual === null) { errors++; continue; }
    confusion[item.expected][item.actual]++;
    if (item.actual === item.expected) correct++;
  }
  const evaluated = outcomes.length - errors;
  return {
    total: outcomes.length,
    correct,
    errors,
    accuracy: evaluated ? correct / evaluated : 0,
    averageLatencyMs: outcomes.length ? latency / outcomes.length : 0,
    tokens: { input, output, total: input + output },
    confusion,
  };
}
