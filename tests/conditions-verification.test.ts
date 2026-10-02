import { test } from "node:test";
import assert from "node:assert/strict";
import { conditionRule, describeConditionCures, gateConditionRemovals, type RemovalEvidence } from "../src/lib/conditions";

const ev = (patch: Partial<RemovalEvidence> = {}): RemovalEvidence => ({ intent: "act", minutes: 10, consumed: [], goldSpent: 0, narration: "", dice: null, ...patch });

test("MECH-4b: fatigue is removed only by real rest, never by a claim", () => {
  const short = gateConditionRemovals(["устал"], ev());
  assert.deepEqual(short.restored, ["устал"]);
  assert.match(short.reasons[0], /отдыхом от 2 ч; за ход прошло 10 мин/);
  assert.deepEqual(gateConditionRemovals(["устал"], ev({ minutes: 180, action: "Отдыхаю", narration: "Ты отдыхал три часа." })).restored, []);
  assert.deepEqual(gateConditionRemovals(["устал"], ev({ minutes: 480, intent: "claim" })).restored, ["устал"]);
  assert.deepEqual(gateConditionRemovals(["устал"], ev({ minutes: 480, intent: "intend" })).restored, ["устал"]);
});

test("MECH-4b: hunger needs food from the inventory or a paid meal", () => {
  assert.deepEqual(gateConditionRemovals(["голоден"], ev({ narration: "Ты думаешь о еде." })).restored, ["голоден"]);
  assert.deepEqual(gateConditionRemovals(["голоден"], ev({ action: "Ем хлеб", narration: "Ты съел хлеб.", consumed: [{ name: "Ломоть хлеба", kind: "food" }] })).restored, []);
  assert.deepEqual(gateConditionRemovals(["голоден"], ev({ action: "Заказываю обед", goldSpent: 3, narration: "Ты пообедал в таверне." })).restored, []);
  assert.deepEqual(gateConditionRemovals(["голоден"], ev({ consumed: [{ name: "Верёвка", kind: "tool" }] })).restored, ["голоден"]);
});

test("MECH-4b: wounds need medicine, a successful medical check, treatment with cost/time, not elapsed time", () => {
  assert.deepEqual(gateConditionRemovals(["ранен в плечо"], ev()).restored, ["ранен в плечо"]);
  assert.deepEqual(gateConditionRemovals(["ранен в плечо"], ev({ action: "Перевязываю свою рану", narration: "Ты перевязал свою рану.", consumed: [{ name: "Бинты" }] })).restored, []);
  assert.deepEqual(gateConditionRemovals(["ранен в плечо"], ev({ action: "Лечу свою рану", narration: "Ты обработал свою рану.", dice: { success: true, skill: "Медицина" } })).restored, []);
  assert.deepEqual(gateConditionRemovals(["ранен в плечо"], ev({ dice: { success: false, skill: "Медицина" } })).restored, ["ранен в плечо"]);
  assert.deepEqual(gateConditionRemovals(["ранен в плечо"], ev({ action: "Врач, перевяжи мне рану", minutes: 40, narration: "Врач зашил твою рану." })).restored, []);
  assert.deepEqual(gateConditionRemovals(["ранен в плечо"], ev({ minutes: 8 * 60 })).restored, ["ранен в плечо"]);
  assert.deepEqual(gateConditionRemovals(["тяжело ранен"], ev({ minutes: 8 * 60 })).restored, ["тяжело ранен"], "time alone cannot heal wounds");
  assert.deepEqual(gateConditionRemovals(["отравлен"], ev({ consumed: [{ name: "Зелье ночного видения" }] })).restored, ["отравлен"], "not every potion is medicine");
});

test("MECH-4b: short timed and descriptive conditions are not blocked", () => {
  assert.deepEqual(gateConditionRemovals(["напуган", "в плохом настроении", "в ярости"], ev()).restored, []);
  assert.deepEqual(gateConditionRemovals(["под подозрением"], ev({ intent: "ask" })).restored, ["под подозрением"]);
  assert.match(describeConditionCures(["устал", "голоден", "напуган"]), /«устал» — отдыхом от 2 ч; «голоден» — едой/);
  assert.equal(describeConditionCures(["напуган"]), "");
});

test("catalog regressions: ё normalisation and word boundaries", () => {
  assert.equal(conditionRule("Тяжёлое ранение")?.label, "Тяжёлое ранение");
  assert.equal(conditionRule("репутация сохранена"), null);
  assert.equal(conditionRule("бодрствует всю ночь"), null);
  assert.equal(conditionRule("свежий хлеб в сумке"), null);
  assert.equal(conditionRule("рана залечена"), null);
  assert.equal(conditionRule("не выспался")?.label, "Усталость");
});

// A hand-labelled corpus of hero-condition strings, including hard negatives. It measures the catalog, not
// real model output: see docs/world-social-and-consequences.md for the limits of this measurement.
const CORPUS: [string, string | null][] = [
  ["ранен в плечо", "Ранение"], ["легко ранена", "Ранение"], ["кровотечение из раны", "Ранение"], ["перелом руки", "Ранение"],
  ["ушиб колена", "Ранение"], ["глубокий порез на ладони", "Ранение"], ["тяжело ранен", "Тяжёлое ранение"], ["Тяжёлое ранение", "Тяжёлое ранение"],
  ["при смерти", "Тяжёлое ранение"], ["отравлен", "Отравление"], ["отравление грибами", "Отравление"], ["тошнит после ужина", "Отравление"],
  ["тошнота", "Отравление"], ["простужен", "Болезнь"], ["простыл", "Болезнь"], ["лихорадка", "Болезнь"], ["болеет гриппом", "Болезнь"], ["жар", "Болезнь"],
  ["устал", "Усталость"], ["смертельно устала", "Усталость"], ["измотана дорогой", "Усталость"], ["не выспался", "Усталость"],
  ["клонит в сон, сонливость", "Усталость"], ["пьян", "Опьянение"], ["слегка навеселе", "Опьянение"], ["нетрезв", "Опьянение"],
  ["напуган", "Страх"], ["в панике", "Страх"], ["в ужасе", "Страх"], ["в ярости", "Ярость"], ["разгневан на стражу", "Ярость"], ["в гневе", "Ярость"],
  ["под подозрением у стражи", "Под подозрением"], ["в розыске", "Под подозрением"], ["разыскивается", "Под подозрением"], ["подозревают в краже", "Под подозрением"],
  ["промок до нитки", "Продрог"], ["замёрз", "Продрог"], ["продрогла на ветру", "Продрог"], ["голоден", "Голод"], ["голодна", "Голод"], ["не ел два дня", "Голод"],
  ["вдохновлён", "Вдохновение"], ["воодушевлена", "Вдохновение"], ["на подъёме", "Вдохновение"], ["хорошо отдохнул", "Отдых"], ["выспался", "Отдых"],
  ["бодр и свеж", "Отдых"], ["сосредоточен", "Сосредоточенность"], ["в потоке", "Сосредоточенность"],
  ["не ранен", null], ["больше не устала", null], ["ранения нет", null], ["усталость прошла", null], ["рана залечена", null],
  ["репутация сохранена", null], ["под охраной", null], ["бодрствует всю ночь", null], ["собранные вещи", null], ["спокоен", null],
  ["в хорошем настроении", null], ["влюблён", null], ["свежий хлеб в сумке", null], ["страховка оплачена", null], ["ранний подъём", null], ["пожар позади", null],
];

test("condition catalog corpus: precision and recall are measured and bounded", () => {
  let truePositive = 0, falsePositive = 0, falseNegative = 0;
  const errors: string[] = [];
  for (const [text, expected] of CORPUS) {
    const actual = conditionRule(text)?.label ?? null;
    if (actual === expected) { if (expected) truePositive++; continue; }
    errors.push(`${text}: ${actual} ≠ ${expected}`);
    if (actual) falsePositive++;
    if (expected) falseNegative++;
  }
  const precision = truePositive / Math.max(1, truePositive + falsePositive);
  const recall = truePositive / Math.max(1, truePositive + falseNegative);
  console.log(`condition-corpus n=${CORPUS.length} precision=${precision.toFixed(3)} recall=${recall.toFixed(3)} errors=${JSON.stringify(errors)}`);
  assert.ok(precision >= 0.97, `precision ${precision}`);
  assert.ok(recall >= 0.95, `recall ${recall}`);
});
