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

test("state-owned resource facts cannot enter semantic memory under another fact type", () => {
  // Catches trusting the model's type label to bypass the resource/state boundary.
  const resource = "Герой получил 500 XP.";
  for (const type of ["npc", "world", "character", "relationship", "promise", "secret", "event"]) {
    const facts = normalizeExtractedFacts({ facts: [
      {
        ...fact, type, entityKey: `${type}:experience`, content: resource, evidence: resource,
      },
      fact,
    ] }, `${resource} ${narration}`, "Осматриваюсь");
    assert.deepEqual(facts, [fact], type);
  }
});

test("semantic character facts retain everyday experience without a numeric resource change", () => {
  const content = "Мария получила опыт ухода за детьми.";
  const characterFact = { ...fact, type: "character", entityKey: "character:care", content, evidence: content };
  assert.deepEqual(normalizeExtractedFacts({ facts: [characterFact] }, content, "Обсуждаю её работу"), [characterFact]);
});

for (const [type, content] of [
  ["character", "Мария подобрала слова, чтобы поддержать Анну."],
  ["npc", "Анна прибыла в город десять лет назад."],
  ["relationship", "Банк потерял кредит доверия Анны."],
  ["character", "Мария получила кредит на лечение и должна банку."],
  ["character", "Мария получила опыт за годы работы с детьми."],
] as const) test(`semantic ${type} facts preserve descriptive and biographical facts: ${content}`, () => {
  const descriptiveFact = { ...fact, type, content, evidence: content };
  assert.deepEqual(normalizeExtractedFacts({ facts: [descriptiveFact] }, content, "Расспрашиваю о её жизни"), [descriptiveFact]);
});
