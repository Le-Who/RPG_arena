import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppliedChanges } from "../src/db/schema";
import { describeConsequences, resourceSnapshot } from "../src/lib/applied-changes";
import { hasNarrativeStateChanges } from "../src/lib/narrative-guard";
import { emptyChanges } from "../src/lib/resolution";

const empty = (): AppliedChanges => ({ hp: 0, xp: 0, gold: 0, danger: 0, levelUp: false, dead: false, location: null, inventory: [], quests: [], npcs: [], sceneObjects: [], conditions: { added: [], removed: [] }, rejected: [] });
test("consequences preserve both HP maxima and use accepted counters rather than stale deltas", () => {
  const before = { hp: 30, maxHp: 40, gold: 5, xp: 119, level: 1 };
  const after = { hp: 35, maxHp: 45, gold: 5, xp: 120, level: 2 };
  const resources = resourceSnapshot(before, after, { before: 1, after: 0 });
  const rows = describeConsequences({ ...empty(), hp: -20, gold: 10, resources });
  assert.deepEqual(rows.find(r => r.subject === "Здоровье"), { group: "Ресурсы", subject: "Здоровье", before: "30/40", after: "35/45", reason: "+5 за ход" });
  assert.equal(rows.some(r => r.subject === "Средства"), false);
  assert.equal(rows.find(r => r.subject === "Уровень")?.after, "2");
  assert.equal(rows.find(r => r.subject === "Опасность")?.after, "0");
  assert.equal(before.maxHp, 40);
});
test("legacy deltas remain readable and quest transitions retain the prior status", () => {
  const rows = describeConsequences({ ...empty(), hp: -2, quests: [{ title: "Встреча", status: "completed", progress: 100, isNew: false, before: { status: "active", progress: 50 }, note: "Встретились" }] });
  assert.equal(rows[0].before, null);
  assert.equal(rows[0].after, "−2");
  assert.deepEqual(rows[1], { group: "Цели", subject: "Встреча", before: "50%", after: "выполнена", reason: "Встретились" });
});
test("unchanged absolute resource values do not escalate descriptive narration", () => {
  const character = { hp: 30, maxHp: 40, gold: 5, xp: 119, level: 1 };
  const payload = { effects: { hp: 0, xp: 0, gold: 0, danger: 0 }, stateChanges: emptyChanges() };
  const resources = resourceSnapshot(character, character, { before: 10, after: 10 });
  assert.equal(hasNarrativeStateChanges(payload, { ...empty(), resources }), false);
  assert.equal(hasNarrativeStateChanges(payload, { ...empty(), resources: { ...resources, gold: { before: 5, after: 4 } } }), true);
  assert.equal(hasNarrativeStateChanges(payload, { ...empty(), resources: { ...resources, hp: { ...resources.hp, maxAfter: 45 } } }), true);
  assert.equal(hasNarrativeStateChanges(payload, { ...empty(), resources, rejected: ["Отказ"] }), true);
});
