import assert from "node:assert/strict";
import test from "node:test";
import { parsePrimitiveAnswers, selectiveMetrics, rankMetrics } from "../scripts/jev-evaluation";
import { scenarios, selectionFor } from "../scripts/narrative-evaluation-fixtures";

test("evaluation routing passes choices and prunes known empty scopes like runtime", () => {
  const base = scenarios.find(s => s.id === "description_weather")!;
  const chosen = selectionFor({ ...base, state: { ...base.state, draft_choices: ["Продать кольцо из своего инвентаря"] } });
  assert.ok(chosen.reasons.includes("consequential_choice"));
  assert.equal(selectionFor(scenarios[0]).questions.choices, undefined);
  assert.ok(selectionFor(scenarios[0]).questions.history_object);
});

test("evaluation separates coverage, selective risk and unavailable from success", () => {
  const result = selectiveMetrics([
    { expected: "consistent", status: "verified" },
    { expected: "contradicts", status: "verified" },
    { expected: "consistent", status: "uncertain" },
    { expected: "insufficient", status: "unavailable" },
    { expected: "consistent", status: "skipped" },
  ]);
  assert.equal(result.modelDecisionCoverage, 2 / 4);
  assert.equal(result.selectiveErrorRate, .5);
  assert.equal(result.acceptedErrorRate, .5);
  assert.equal(result.unavailable, 1);
  assert.equal(result.unchecked, 1);
  assert.equal(selectiveMetrics([]).selectiveErrorRate, null);
  assert.equal(selectiveMetrics([]).acceptedError95Wilson, null);
});

test("zero observed errors still has a nonzero confidence interval", () => {
  const m = selectiveMetrics([{ expected: "consistent", status: "verified" }]);
  assert.ok(m.acceptedError95Wilson![1] > .7);
});

test("ranking gives credit to contradictions as relevant evidence and handles ties deterministically", () => {
  assert.deepEqual(rankMetrics([0, 2, 2], [0, 1, 2]), { top1Direct: 1, directRecallAt2: 1 });
  assert.equal(rankMetrics([0, 2, 2], [1, 1, 1]).directRecallAt2, .5);
});

const questions = { relevance: { type: "score" as const, instructions: "relevance", criteria: ["none", "context", "direct"] }, history: { type: "noul" as const, instructions: "history" } };
const raw = () => ({ model: "typesafe/jev-1.13", usage: { input_tokens: 10, output_tokens: 3 }, answers: { relevance: { type: "score", score: 1.5, confidence: .5, probabilities: { "0": 0, "1": .5, "2": .5 } }, history: { type: "noul", noul: .8 } } });
test("mixed primitive parser preserves distribution and does not invent Noul confidence", () => {
  const parsed = parsePrimitiveAnswers(raw(), questions);
  assert.equal(parsed.answers.history.noul, .8);
  assert.equal(parsed.answers.relevance.score, 1.5);
});
test("malformed primitive responses cannot become useful measurements", () => {
  for (const mutation of [
    (v: ReturnType<typeof raw>) => { v.answers.history.noul = NaN; },
    (v: ReturnType<typeof raw>) => { v.answers.relevance.score = 2; },
    (v: ReturnType<typeof raw>) => { v.answers.relevance.probabilities["0"] = .5; },
    (v: ReturnType<typeof raw>) => { v.model = "other"; },
    (v: ReturnType<typeof raw>) => { v.usage.input_tokens = -1; },
  ]) { const v = raw(); mutation(v); assert.throws(() => parsePrimitiveAnswers(v, questions)); }
  const missing = raw(); delete (missing.answers as Record<string, unknown>).history;
  assert.throws(() => parsePrimitiveAnswers(missing, questions));
});
