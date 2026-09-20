import test from "node:test";
import assert from "node:assert/strict";
import { scoreNarrativeEvaluation, scenarios, selectionFor } from "../scripts/narrative-evaluation-fixtures";

test("evaluation distinguishes unsafe acceptance, false rejection, abstention and availability", () => {
  const result = scoreNarrativeEvaluation([
    { expected: "contradicts", status: "verified", latencyMs: 10 },
    { expected: "consistent", status: "rejected", latencyMs: 20 },
    { expected: "consistent", status: "uncertain", latencyMs: 30 },
    { expected: "insufficient", status: "uncertain", latencyMs: 40 },
    { expected: "consistent", status: "unavailable", latencyMs: 5000 },
    { expected: "consistent", status: "skipped", latencyMs: 0 },
  ]);
  assert.equal(result.falseAccepts, 1);
  assert.equal(result.falseRejects, 1);
  assert.equal(result.abstentions, 2);
  assert.equal(result.unavailable, 1);
  assert.equal(result.safeBypasses, 1);
  assert.equal(result.completeResponseLatency.p50, 20);
  assert.equal(result.completeResponseLatency.p95, 40);
});

test("Russian synthetic corpus covers guarded cases and descriptive safe bypasses", () => {
  assert.ok(scenarios.length >= 20);
  assert.equal(new Set(scenarios.map(s => s.id)).size, scenarios.length);
  for (const scenario of scenarios) {
    assert.equal(selectionFor(scenario).required, scenario.shouldGuard, scenario.id);
    assert.equal(scenario.state.draft, scenario.narration);
  }
});
