import { test } from "node:test";
import assert from "node:assert/strict";
import { portableFixture, now } from "./helpers/portable-fixture";
import { createPortableDocument, parsePortableDocument } from "../src/lib/campaign-portable";
import { resourceSnapshot } from "../src/lib/applied-changes";

test("portable JSON preserves resource maxima, quest before-state and optional legacy fields", () => {
  const snapshot = portableFixture();
  const before = { hp: 30, maxHp: 40, xp: 119, level: 1, gold: 5 };
  snapshot.turns[0].stateChanges = {
    hp: 5, xp: 1, gold: 0, danger: -1, levelUp: true, dead: false, location: null,
    quests: [{ title: "Встреча", status: "completed", progress: 100, isNew: false, before: { status: "active", progress: 20 }, note: "Встретились" }],
    npcs: [], inventory: [], sceneObjects: [], conditions: { added: [], removed: [] }, rejected: [],
    resources: resourceSnapshot(before, { ...before, hp: 35, maxHp: 45, xp: 120, level: 2 }, { before: 10, after: 9 }),
  };
  const result = parsePortableDocument(JSON.parse(JSON.stringify(createPortableDocument(snapshot, now))));
  assert.deepEqual(result.snapshot.turns[0].stateChanges, snapshot.turns[0].stateChanges);
  const legacy = portableFixture();
  assert.deepEqual(parsePortableDocument(createPortableDocument(legacy, now)).snapshot, legacy);
});

test("portable resource snapshots reject unknown fields, missing maxima and unbounded numbers", () => {
  for (const invalidHp of [
    { before: 1, after: 2, maxBefore: 40, maxAfter: 45, max: 45 },
    { before: 1, after: 2, maxAfter: 45 },
    { before: 1, after: 2, maxBefore: 40, maxAfter: 1e15 },
  ]) {
    const snapshot = portableFixture();
    snapshot.turns[0].stateChanges = { hp: 1, xp: 0, gold: 0, danger: 0, levelUp: false, dead: false, location: null, quests: [], npcs: [], inventory: [], sceneObjects: [], conditions: { added: [], removed: [] }, rejected: [], resources: { hp: invalidHp, gold: { before: 1, after: 1 }, xp: { before: 1, after: 1 }, danger: { before: 1, after: 1 } } } as typeof snapshot.turns[0]["stateChanges"];
    assert.throws(() => parsePortableDocument(createPortableDocument(snapshot, now)), /Некорректное поле/);
  }
});
