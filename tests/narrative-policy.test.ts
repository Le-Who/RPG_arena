import assert from "node:assert/strict";
import test from "node:test";
import { selectNarrativeChecks, parseNarrativeDeclaration } from "../src/lib/narrative-policy";

const descriptive = { mode: "description", referencesPast: false };
const base = () => ({ action: "Посмотреть на облака", narration: "Облака медленно плывут над лесом.", declaration: descriptive, hasDice: false, hasStateChanges: false, rejected: [] as string[] });

test("ordinary description skips provider checks but missing/invalid declarations do not", () => {
  assert.equal(selectNarrativeChecks(base()).required, false);
  for (const declaration of [undefined, null, {}, { mode: "description", referencesPast: "false" }, { mode: "unknown", referencesPast: false }]) {
    assert.equal(selectNarrativeChecks({ ...base(), declaration }).required, true);
  }
  assert.deepEqual(parseNarrativeDeclaration(descriptive), descriptive);
});

test("failed pants acquisition selects outcome and accepted-state checks, independent of declaration", () => {
  const result = selectNarrativeChecks({ ...base(), action: "Попросить штаны", narration: "Тебе бросают штаны, и ты надеваешь их.", hasDice: true, hasStateChanges: true, rejected: ["Предмет не получен: действие провалено"] });
  assert.equal(result.required, true);
  assert.ok(result.reasons.includes("rejected_change"));
  assert.ok(result.questions.outcome);
  assert.ok(result.questions.accepted_state);
  assert.ok(result.questions.unlisted_events);
});

test("historical references in action or prose require independent-source checks", () => {
  for (const values of [
    { action: "Напомнить про сделку о передаче во владение" },
    { narration: "Ты вспоминаешь: хозяин давно подарил тебе этот дом." },
    { narration: "Как мы договорились, район принадлежит тебе." },
    { declaration: { mode: "description", referencesPast: true } },
  ]) {
    const checks = selectNarrativeChecks({ ...base(), ...values });
    assert.equal(checks.required, true);
    assert.ok(checks.questions.history_object);
    assert.match(checks.questions.history_object.instructions, /недостаточно|источник/i);
  }
});

test("unlisted consequential prose escalates even when the model declares only description", () => {
  for (const narration of ["Теперь ключ у тебя в кармане.", "Стражник мёртв.", "Ты пересекаешь порог и оказываешься в замке.", "Долг прощён.", "You receive a key."]) {
    const result = selectNarrativeChecks({ ...base(), narration });
    assert.equal(result.required, true, narration);
    assert.ok(result.questions.unlisted_events);
  }
});

test("a harmless description cannot bypass checks on consequential choices and accepted notes", () => {
  const choice = selectNarrativeChecks({ ...base(), choices: ["Продать кольцо из своего инвентаря"] });
  assert.equal(choice.required, true);
  assert.ok(choice.reasons.includes("consequential_choice"));
  assert.ok(selectNarrativeChecks({ ...base(), hasStateChanges: true }).questions.accepted_notes);
});

test("checks are bounded, independently answerable and never trust narration as historical proof", () => {
  const result = selectNarrativeChecks({ ...base(), hasDice: true, hasStateChanges: true, hasProvisionalIndependentAdds: true, rejected: ["x"], declaration: null, action: "Вспомнить старый договор", narration: "Ты получил меч и стал владельцем дома." });
  assert.ok(Object.keys(result.questions).length <= 12);
  assert.equal(new Set(Object.keys(result.questions)).size, Object.keys(result.questions).length);
  for (const question of Object.values(result.questions)) {
    assert.equal(question.type, "choice");
    assert.deepEqual(Object.keys(question.criteria), ["consistent", "contradicts", "insufficient"]);
  }
  assert.match(result.questions.history_object.instructions, /черновик.*не.*доказательств/i);
});
test("independent acquisition criteria require positive evidence even when narration omits the item", () => {
  const selection = selectNarrativeChecks({ action: "Открыть ворота", narration: "Тишина.", declaration: { mode: "event", referencesPast: false }, hasDice: true, hasStateChanges: true, hasProvisionalIndependentAdds: true, rejected: [] });
  const check = selection.questions.independent_acquisitions;
  assert.match(check.criteria.consistent, /каждой операции/i);
  assert.match(check.criteria.consistent, /количество/);
  assert.doesNotMatch(check.criteria.consistent, /утверждений нет/);
});
