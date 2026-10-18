import test from "node:test";
import assert from "node:assert/strict";
import { normalizeExtractedFacts } from "../src/lib/memory";

const narration = "Мария ждёт у библиотеки. Анна работает в городском архиве.";
const fact = {
  type: "npc", entityKey: "npc:maria", title: "Мария",
  content: "Мария ждёт у библиотеки.", evidence: "Мария ждёт у библиотеки", importance: 65, confidence: 0.9,
};

// JSON objects with a shadowed toString must not abort the batch before a valid sibling.
test("memory extraction ignores an object-valued fact type without losing a valid sibling", () => {
  const facts = normalizeExtractedFacts({ facts: [
    { ...fact, type: { toString: null } },
    { ...fact, entityKey: "npc:anna", title: "Анна", content: "Анна работает в городском архиве.", evidence: "Анна работает в городском архиве" },
  ] }, narration, "Спрашиваю дорогу");
  assert.deepEqual(facts, [{
    type: "npc", entityKey: "npc:anna", title: "Анна", content: "Анна работает в городском архиве.",
    evidence: "Анна работает в городском архиве", importance: 65, confidence: 0.9,
  }]);
});

test("memory extraction defaults object-valued importance while preserving evidence and valid siblings", () => {
  const facts = normalizeExtractedFacts({ facts: [
    { ...fact, importance: { toString: null } },
    { ...fact, entityKey: "npc:anna", title: "Анна", content: "Анна работает в городском архиве.", evidence: "Анна работает в городском архиве" },
  ] }, narration, "Спрашиваю дорогу");
  assert.deepEqual(facts.map(value => [value.entityKey, value.importance, value.evidence]), [
    ["npc:maria", 55, "Мария ждёт у библиотеки"],
    ["npc:anna", 65, "Анна работает в городском архиве"],
  ]);
});
