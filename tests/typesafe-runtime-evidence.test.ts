import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TYPE_SAFE_MODEL, verifyTypeSafeFacts } from "../src/lib/typesafe";

test("verifyTypeSafeFacts rejects malformed model answers through the actual Jev adapter", async () => {
  const goodAnswer = { type: "choice", choice: "supports", probabilities: { supports: 1, contradicts: 0, unsupported: 0 }, confidence: 1 };
  for (const answers of [null, {}, { fact0: null }, { fact0: { ...goodAnswer, choice: "maybe" } }, { fact0: { ...goodAnswer, probabilities: { supports: 1.1, contradicts: 0, unsupported: 0 } } }, { fact0: { ...goodAnswer, confidence: -0.1 } }]) {
    const report = await verifyTypeSafeFacts({ enabled: true, apiKey: "fixture-key", facts: [{ type: "world", entityKey: "world:cafe", title: "Дверь", content: "Дверь открыта.", evidence: "Анна открыла дверь.", importance: 50, confidence: 1 }], narration: "Анна открыла дверь.", playerAction: "Открыть дверь", fetchImpl: async () => Response.json({ model: TYPE_SAFE_MODEL, answers, usage: { input_tokens: 1, output_tokens: 1 } }) });
    assert.equal(report.status, "error"); assert.deepEqual(report.evaluations, []); assert.equal(report.usage, null);
  }
});

test("cancellation gold refutes a current scheduled future meeting, preserving historical-promise contrast", () => {
  const scenarios = JSON.parse(readFileSync(new URL("./fixtures/typesafe-scenarios.json", import.meta.url), "utf8")) as { id: string; narration: string; fact: string; expected: string }[];
  const cancellation = scenarios.find(item => item.id === "contradict-15");
  assert.equal(cancellation?.fact, "Сейчас назначена будущая встреча Ирмы с героем у старой мельницы.");
  assert.equal(cancellation.expected, "contradicts");
  // Labels are authored semantic controls, not model-quality evidence: a later cancellation does not erase a promise.
  const historical = scenarios.find(item => item.id === "support-15");
  assert.equal(historical?.fact, "Ирма обещала встречу у старой мельницы.");
  assert.equal(historical.expected, "supports");
  assert.ok(historical.narration.includes("обещала")); assert.ok(historical.narration.includes("отменила"));
});
