import { test } from "node:test";
import assert from "node:assert/strict";
import { applyResolution, parseResolution, type ApplyInput } from "../src/lib/resolution";
import { roll2d6 } from "../src/lib/dice";

function baseInput(over: Partial<ApplyInput> = {}): ApplyInput {
  return {
    rulesProfile: "d20",
    campaignMode: "free",
    character: { name: "Ада", archetype: "Следователь", level: 1, xp: 0, hp: 30, maxHp: 40, gold: 15, stats: { СИЛ: 10 }, skills: [], traits: [], backstory: "", appearance: "", conditions: [] },
    world: { worldName: "Город", tone: "нуар", era: "1950", mainQuest: "Найти брата", currentLocation: "Бар «Ржавый якорь»", factions: [], flags: {}, danger: 30, chapter: 1 },
    inventory: [{ id: "aaaaaaaa-0000-0000-0000-000000000000", name: "Аптечка", kind: "consumable", quantity: 1, equipped: false, description: "", icon: "🧪", power: 10 }],
    quests: [{ id: "q1", key: "main", title: "Найти брата", status: "active", progress: 10, isMain: true, description: "" }],
    npcs: [],
    sceneObjects: [],
    locations: [{ id: "l1", name: "Бар «Ржавый якорь»", x: 5, y: 5, current: true, discovered: true, danger: 20 }],
    payload: parseResolution("{}").payload,
    dice: null,
    turnNumber: 5,
    rng: () => 0.5,
    ...over,
  };
}

test("new inventory can be equipped and stacked in the same turn using one generated identity", () => {
  const input = baseInput({ payload: parseResolution(JSON.stringify({ stateChanges: { inventory: [
    { op: "add", name: "Штаны", kind: "armor", quantity: 1 },
    { op: "equip", name: "Штаны" },
    { op: "add", name: "Штаны", kind: "armor", quantity: 1 },
  ] } })).payload });
  const before = structuredClone(input.inventory);
  const result = applyResolution(input);
  assert.deepEqual(result.applied.inventory.map(item => item.ok), [true, true, true]);
  const inserts = result.ops.filter(op => op.t === "inv.insert");
  assert.equal(inserts.length, 1);
  const updates = result.ops.filter(op => op.t === "inv.update");
  assert.equal(updates.length, 2);
  assert.equal(updates[0].id, inserts[0].row.id);
  assert.equal(updates[1].id, inserts[0].row.id);
  assert.deepEqual(updates[0].patch, { equipped: true });
  assert.deepEqual(updates[1].patch, { quantity: 2 });
  assert.deepEqual(input.inventory, before);
});

test("an independent acquisition after failure is only a provisional candidate for mandatory verification", () => {
  const payload = parseResolution(JSON.stringify({ stateChanges: { inventory: [
    { op: "add", name: "Аптечка", quantity: 2, checkDependency: "independent" },
    { op: "add", name: "Награда за успех", quantity: 1 },
  ] } })).payload;
  const dice = { ...roll2d6("Риск", 0, () => 0), goal: "Взломать сейф" };
  const denied = applyResolution(baseInput({ payload, dice }));
  assert.ok(denied.applied.inventory.every(i => !i.ok));
  const candidate = applyResolution(baseInput({ payload, dice, allowProvisionalIndependentAdds: true }));
  assert.deepEqual(candidate.applied.inventory.map(i => i.ok), [true, false]);
  assert.equal(candidate.provisionalIndependentAdds.length, 1);
  assert.equal(candidate.provisionalIndependentAdds[0].quantity, 2);
  assert.equal(candidate.provisionalIndependentAdds[0].ref, "aaaaaaaa-0000-0000-0000-000000000000");
});

test("same-turn acquired items can be removed once and failed acquisition cannot be equipped", () => {
  const payload = parseResolution(JSON.stringify({ stateChanges: { inventory: [
    { op: "add", name: "Штаны", kind: "armor" },
    { op: "remove", name: "Штаны" },
    { op: "equip", name: "Штаны" },
  ] } })).payload;
  const result = applyResolution(baseInput({ payload }));
  assert.deepEqual(result.applied.inventory.map(item => item.ok), [true, true, false]);
  const inserted = result.ops.find(op => op.t === "inv.insert");
  const deleted = result.ops.find(op => op.t === "inv.delete");
  assert.equal(deleted?.id, inserted?.row.id);
  const failed = applyResolution(baseInput({ payload, dice: roll2d6("Риск", 0, () => 0) }));
  assert.deepEqual(failed.applied.inventory.map(item => item.ok), [false, false, false]);
  assert.equal(failed.ops.filter(op => op.t.startsWith("inv.")).length, 0);
});

test("reacquiring a removed item creates a fresh row instead of updating a deleted identity", () => {
  const input = baseInput({ payload: parseResolution(JSON.stringify({ stateChanges: { inventory: [
    { op: "remove", name: "Аптечка" },
    { op: "add", name: "Аптечка", kind: "consumable" },
    { op: "equip", name: "Аптечка" },
  ] } })).payload });
  const result = applyResolution(input);
  const inserted = result.ops.find(op => op.t === "inv.insert");
  assert.ok(inserted);
  assert.notEqual(inserted.row.id, input.inventory[0].id);
  const updated = result.ops.filter(op => op.t === "inv.update");
  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, inserted.row.id);
  assert.deepEqual(result.applied.inventory.map(item => item.ok), [true, true, true]);
});
