import test from "node:test";
import assert from "node:assert/strict";
import { GUARDED_RESOLUTION_SCHEMA, parseNarrativeRepair, guardedPreview } from "../src/lib/narrative-generation";
import { emptyChanges } from "../src/lib/resolution";

const draft = () => ({ continuity: { mode: "description", referencesPast: false }, outcome: "neutral", effects: { hp: 0, xp: 0, gold: 0, danger: 0 }, stateChanges: emptyChanges(), choices: [], narration: "Туман. Незаконченная фраза" });
test("guarded schema places complete metadata before narration", () => {
  const order = GUARDED_RESOLUTION_SCHEMA.propertyOrdering as string[];
  assert.equal(order.at(-1), "narration");
  assert.ok(order.indexOf("continuity") < order.indexOf("narration"));
});
test("only descriptive sentences stream; dice, automatic XP, consequences and invalid headers hold text", () => {
  const json = JSON.stringify(draft());
  const base = { action: "Посмотреть вокруг", hasDice: false, automaticEffects: false };
  assert.equal(guardedPreview(json, base), "Туман.");
  assert.equal(guardedPreview(json, { ...base, hasDice: true }), "");
  assert.equal(guardedPreview(json, { ...base, automaticEffects: true }), "");
  assert.equal(guardedPreview(JSON.stringify({ ...draft(), narration: "Ты получил ключ." }), base), "");
  assert.equal(guardedPreview('{"narration":"Туман."}', base), "");
  assert.equal(guardedPreview(JSON.stringify({ ...draft(), effects: null }), base), "");
  assert.equal(guardedPreview(JSON.stringify({ ...draft(), stateChanges: { unknownEvent: "Герой стал королём" } }), base), "");
  assert.equal(guardedPreview(JSON.stringify({ ...draft(), continuity: { ...draft().continuity, agreements: [{ object: "Дом" }] } }), base), "");
});
test("repair accepts prose and choices only, refusing attempted state rewrites", () => {
  assert.deepEqual(parseNarrativeRepair('{"narration":"Отказ.","choices":["Уйти"]}'), { narration: "Отказ.", choices: ["Уйти"] });
  for (const text of ['{"narration":"Да","choices":[],"effects":{"gold":5}}', '{"narration":"Да","choices":[],"narration":"Нет"}', '{"narration":"","choices":[]}', '{"narration":"Да","choices":[4]}']) assert.equal(parseNarrativeRepair(text), null);
});
