import test from "node:test";
import assert from "node:assert/strict";
import { applyResolution, parseResolution, type ApplyInput } from "../src/lib/resolution";
import { selectStateEvents } from "../src/lib/memory";

const kitId = "abcdef00-0000-4000-8000-000000000001";
const secondId = "abcdef00-0000-4000-8000-000000000002";

function input(raw: string, overrides: Partial<ApplyInput> = {}): ApplyInput {
  return {
    rulesProfile: "d20", campaignMode: "free", turnNumber: 7, dice: null,
    character: { name: "Ада", archetype: "Исследователь", level: 1, xp: 0, hp: 30, maxHp: 40, gold: 15, stats: { СИЛ: 10 }, skills: [], traits: [], backstory: "", appearance: "", conditions: ["Усталость"] },
    world: { worldName: "Город", tone: "спокойный", era: "сегодня", mainQuest: "Архив", currentLocation: "Площадь", factions: [], flags: { known: true }, danger: 30, chapter: 1 },
    inventory: [{ id: kitId, name: "Аптечка", kind: "consumable", quantity: 3, equipped: false, description: "", icon: "🧪", power: 4 }],
    quests: [{ id: "q1", key: "archive", title: "Архив", description: "", status: "active", progress: 10, isMain: true }],
    npcs: [{ id: "n1", key: "anna", name: "Анна", role: "архивариус", description: "", relation: 0, status: "alive" }],
    sceneObjects: [{ id: "s1", key: "door", name: "Дверь", state: "закрыта", locationName: "Площадь", description: "" }],
    locations: [{ id: "square", name: "Площадь", x: 5, y: 5, current: true, discovered: true, danger: 30 }],
    payload: parseResolution(raw).payload,
    ...overrides,
  };
}

function checkedApply(value: ApplyInput) {
  // Factories are test controls; all domain state is JSON serializable.
  const before = JSON.parse(JSON.stringify(value));
  const result = applyResolution(value);
  assert.deepEqual(JSON.parse(JSON.stringify(value)), before, "parser output and caller state must remain unchanged");
  return result;
}

// Reusing the initial NPC snapshot would lose the first accepted delta and its note.
test("resolution batch: repeated NPC changes accumulate accepted relationships and notes", () => {
  const result = checkedApply(input(JSON.stringify({ stateChanges: { npcs: [
    { ref: "anna", relationDelta: 10, note: "Помогла с архивом." },
    { ref: "anna", relationDelta: 10, note: "Согласилась встретиться." },
  ] } })));
  const updates = result.ops.filter(op => op.t === "npc.update");
  assert.deepEqual(updates.map(op => op.patch.relation), [10, 20]);
  assert.equal(updates[1].patch.description, "[ход 7] Помогла с архивом. [ход 7] Согласилась встретиться.");
  assert.deepEqual(result.applied.npcs.map(npc => [npc.relation, npc.delta]), [[10, 10], [20, 10]]);
  assert.match(result.events.at(-1)!.content, /Отношение \+20/);
  const canonical = selectStateEvents(result.events).filter(event => event.entityKey === "npc:anna");
  assert.equal(canonical.length, 1);
  assert.match(canonical[0].content, /Отношение \+20/);
});

for (const row of [{ tail: 5, final: 15 }, { tail: -5, final: 5 }]) {
  test(`resolution batch: a small trailing NPC delta ${row.tail} refreshes already emitted canonical memory`, () => {
    const result = checkedApply(input(JSON.stringify({ stateChanges: { npcs: [
      { ref: "anna", relationDelta: 10 }, { ref: "anna", relationDelta: row.tail },
    ] } })));
    assert.deepEqual(result.ops.filter(op => op.t === "npc.update").map(op => op.patch.relation), [10, row.final]);
    const canonical = selectStateEvents(result.events).filter(event => event.entityKey === "npc:anna");
    assert.equal(canonical.length, 1);
    assert.match(canonical[0].content, new RegExp(`Отношение \\+${row.final}\\.`));
  });
}

test("resolution batch: refreshing an NPC event after a small delta preserves its earlier note", () => {
  const result = checkedApply(input(JSON.stringify({ stateChanges: { npcs: [
    { ref: "anna", relationDelta: 10, note: "Помогла с архивом." }, { ref: "anna", relationDelta: 5 },
  ] } })));
  const canonical = selectStateEvents(result.events).filter(event => event.entityKey === "npc:anna");
  assert.equal(canonical.length, 1);
  assert.match(canonical[0].content, /Отношение \+15\./);
  assert.match(canonical[0].content, /Помогла с архивом\./);
});

test("resolution batch: small NPC deltas do not create standalone semantic events or borrow another NPC's novelty", () => {
  const standalone = checkedApply(input(JSON.stringify({ stateChanges: { npcs: [{ ref: "anna", relationDelta: 5 }] } })));
  assert.deepEqual(standalone.ops.filter(op => op.t === "npc.update").map(op => op.patch.relation), [5]);
  assert.equal(selectStateEvents(standalone.events).filter(event => event.category === "npc").length, 0);
  const initial = input("{}");
  const result = checkedApply(input(JSON.stringify({ stateChanges: { npcs: [
    { ref: "anna", relationDelta: 10 }, { ref: "boris", relationDelta: 5 },
  ] } }), { npcs: [...initial.npcs, { ...initial.npcs[0], id: "n2", key: "boris", name: "Борис" }] }));
  assert.deepEqual(result.ops.filter(op => op.t === "npc.update").map(op => op.patch.relation), [10, 5]);
  assert.deepEqual(selectStateEvents(result.events).filter(event => event.category === "npc").map(event => event.entityKey), ["npc:anna"]);
});

for (const row of [
  { initial: 0, delta: 20, relations: [20, 30, 30], deltas: [20, 10, 0] },
  { initial: 0, delta: -20, relations: [-20, -30, -30], deltas: [-20, -10, 0] },
  { initial: 98, delta: 20, relations: [100, 100, 100], deltas: [2, 0, 0] },
  { initial: -98, delta: -20, relations: [-100, -100, -100], deltas: [-2, 0, 0] },
]) test(`resolution batch: repeated NPC deltas ${row.delta} from ${row.initial} share turn and absolute limits`, () => {
  const initial = input("{}");
  const result = checkedApply(input(JSON.stringify({ stateChanges: { npcs: [
    { ref: "anna", relationDelta: row.delta }, { ref: "anna", relationDelta: row.delta }, { ref: "anna", relationDelta: row.delta },
  ] } }), { npcs: initial.npcs.map(npc => ({ ...npc, relation: row.initial })) }));
  assert.deepEqual(result.ops.filter(op => op.t === "npc.update").map(op => op.patch.relation), row.relations);
  assert.deepEqual(result.applied.npcs.map(npc => npc.delta), row.deltas);
});

// A later proposal must observe the terminal state accepted earlier in the batch.
test("resolution batch: a completed quest cannot be reopened by a later proposal", () => {
  const result = checkedApply(input(JSON.stringify({ stateChanges: { quests: [
    { ref: "archive", status: "completed" }, { ref: "archive", status: "active", progress: 15 },
  ] } })));
  assert.deepEqual(result.ops.filter(op => op.t === "quest.update"), [{ t: "quest.update", id: "q1", patch: { status: "completed", progress: 100 } }]);
  assert.equal(result.applied.quests.length, 1);
  assert.equal(result.applied.rejected.length, 1);
});

test("resolution batch: an NPC killed earlier in the batch cannot be restored by a later proposal", () => {
  const result = checkedApply(input(JSON.stringify({ stateChanges: { npcs: [
    { ref: "anna", status: "dead" }, { ref: "anna", status: "alive", relationDelta: 10 },
  ] } })));
  assert.deepEqual(result.ops.filter(op => op.t === "npc.update").map(op => op.patch.status), ["dead"]);
  assert.equal(result.applied.npcs.length, 1);
  assert.equal(result.applied.rejected.length, 1);
});

// Comparing the second state to the original closed door would incorrectly skip it.
test("resolution batch: a scene object can return to its initial state within one turn", () => {
  const result = checkedApply(input(JSON.stringify({ stateChanges: { sceneObjects: [
    { ref: "door", state: "открыта" }, { ref: "door", state: "закрыта" },
  ] } })));
  assert.deepEqual(result.ops.filter(op => op.t === "scene.update").map(op => op.patch.state), ["открыта", "закрыта"]);
  assert.deepEqual(result.applied.sceneObjects.map(object => object.state), ["открыта", "закрыта"]);
  assert.match(result.events.at(-1)!.content, /состояние: закрыта/);
  const canonical = selectStateEvents(result.events).filter(event => event.entityKey === "object:door");
  assert.equal(canonical.length, 1);
  assert.match(canonical[0].content, /состояние: закрыта/);
});

test("a referenced scene object keeps its actual location in canonical memory after the hero moves", () => {
  const value = input(JSON.stringify({ stateChanges: {
    location: { action: "move", ref: "archive", name: "Архив" },
    sceneObjects: [{ ref: "door", state: "заперта" }],
  } }));
  value.locations.push({ id: "archive", name: "Архив", x: 7, y: 5, current: false, discovered: true, danger: 0 });
  const result = checkedApply(value);
  assert.equal(result.world.currentLocation, "Архив");
  assert.deepEqual(result.ops.filter(op => op.t === "scene.update"), [{ t: "scene.update", id: "s1", patch: { state: "заперта", description: undefined } }]);
  const canonical = selectStateEvents(result.events).find(event => event.entityKey === "object:door");
  assert.equal(canonical?.title, "Объект: Дверь (Площадь)");
  assert.equal(canonical?.content, "Дверь в «Площадь» — состояние: заперта.  (ход 7)");
});

// Inserts use ON CONFLICT DO NOTHING: announcing a second same-key row would invent state.
test("resolution batch: duplicate new entity keys report only the row that can be persisted", () => {
  const result = checkedApply(input(JSON.stringify({ stateChanges: {
    quests: [{ title: "Новая цель", progress: 10 }, { title: "НОВАЯ ЦЕЛЬ", progress: 90 }],
    npcs: [{ name: "Борис", relationDelta: 5 }, { name: "БОРИС", relationDelta: -5 }],
    sceneObjects: [{ name: "Окно", state: "целое" }, { name: "ОКНО", state: "разбито" }],
  } })));
  assert.equal(result.ops.filter(op => op.t === "quest.insert").length, 1);
  assert.equal(result.ops.filter(op => op.t === "npc.insert").length, 1);
  assert.equal(result.ops.filter(op => op.t === "scene.insert").length, 1);
  assert.deepEqual(result.applied.quests.map(quest => quest.progress), [10]);
  assert.deepEqual(result.applied.npcs.map(npc => npc.relation), [5]);
  assert.deepEqual(result.applied.sceneObjects.map(object => object.state), ["целое"]);
  assert.equal(result.applied.rejected.length, 3);
  assert.equal(result.events.some(event => event.content.includes("разбито") || event.content.includes("-5")), false);
});

// Catches malformed envelopes escaping into reducers or awarding proposed resources.
for (const envelope of [null, false, 12, "ответ", [], { stateChanges: false, effects: "ошибка" }, { stateChanges: [], effects: [] }]) {
  test(`resolution boundary: malformed envelope ${JSON.stringify(envelope)} is safe through application`, () => {
    const result = checkedApply(input(JSON.stringify(envelope)));
    assert.equal(result.character.hp, 30);
    assert.equal(result.character.gold, 15);
    assert.equal(result.world.danger, 30);
    assert.deepEqual(result.ops, []);
    assert.deepEqual(result.applied.inventory, []);
    assert.deepEqual(result.world.flags, { known: true });
  });
}

// Catches accepting malformed collection rows or dropping a separate valid sibling.
test("resolution boundary: malformed nested collections preserve valid quest, NPC, scene, route and inventory siblings", () => {
  const raw = JSON.stringify({ effects: { xp: 1 }, stateChanges: {
    location: ["move", "Порт"],
    locations: [null, false, { name: "Библиотека", danger: 8 }],
    routes: [null, 5, { from: "square", to: "library" }],
    quests: [null, { ref: "archive", progress: 45 }, { title: [] }],
    npcs: [false, { ref: "anna", relationDelta: 5 }],
    inventory: [null, "consume", { op: "consume", ref: "#abcdef", quantity: 1 }],
    sceneObjects: [[], { ref: "door", state: "открыта" }],
    conditions: { add: [null, {}, "Сосредоточенность"], remove: [false, "усталость"] },
    flags: [{ key: null }, false, { key: "visited", value: "yes" }],
  } });
  const value = input(raw, { makeLocationId: () => "library" });
  const result = checkedApply(value);
  assert.equal(result.character.hp, 34);
  assert.deepEqual(result.character.conditions, ["Сосредоточенность"]);
  assert.deepEqual(result.world.flags, { known: true, visited: "yes" });
  assert.equal(result.world.currentLocation, "Площадь");
  assert.deepEqual(result.ops.filter(op => op.t === "inv.update"), [{ t: "inv.update", id: kitId, patch: { quantity: 2 } }]);
  assert.deepEqual(result.ops.filter(op => op.t === "quest.update"), [{ t: "quest.update", id: "q1", patch: { progress: 45 } }]);
  assert.deepEqual(result.applied.npcs.map(npc => ({ name: npc.name, delta: npc.delta })), [{ name: "Анна", delta: 5 }]);
  assert.deepEqual(result.applied.sceneObjects, [{ name: "Дверь", state: "открыта", isNew: false }]);
  assert.deepEqual(result.ops.filter(op => op.t === "loc.connect"), [{ t: "loc.connect", fromId: "square", toId: "library" }]);
  assert.equal(result.applied.rejected.length, 0);
});

for (const malformed of [null, false, 7, "ошибка", {}]) {
  test(`resolution boundary: wrong collection containers ${JSON.stringify(malformed)} leave a valid resource sibling intact`, () => {
    const result = checkedApply(input(JSON.stringify({ effects: { gold: 3, xp: 1 }, stateChanges: {
      quests: malformed, npcs: malformed, inventory: malformed, sceneObjects: malformed,
      locations: malformed, routes: malformed, conditions: malformed,
    } })));
    assert.equal(result.character.gold, 18);
    assert.equal(result.applied.gold, 3);
    assert.deepEqual(result.applied.resources?.gold, { before: 15, after: 18 });
    assert.deepEqual(result.ops, []);
    assert.deepEqual(result.character.conditions, ["Усталость"]);
  });
}

// JSON objects can shadow Object.prototype.toString. Numeric normalization must not execute coercion on them.
for (const row of [
  { name: "effect", effects: { hp: { toString: null }, gold: 3, xp: 1 }, changes: {}, wantOps: [] },
  { name: "quest progress", effects: { gold: 3, xp: 1 }, changes: { quests: [{ ref: "archive", progress: { toString: null } }] }, wantOps: [] },
  { name: "NPC relation", effects: { gold: 3, xp: 1 }, changes: { npcs: [{ ref: "anna", relationDelta: { toString: null } }] }, wantOps: ["npc.update"] },
  { name: "inventory quantity", effects: { gold: 3, xp: 1 }, changes: { inventory: [{ op: "consume", ref: kitId, quantity: { toString: null } }] }, wantOps: ["inv.update"] },
  { name: "location danger", effects: { gold: 3, xp: 1 }, changes: { locations: [{ name: "Библиотека", danger: { toString: null } }] }, wantOps: ["loc.insert"] },
]) {
  test(`resolution boundary: object-valued ${row.name} cannot abort a valid gold sibling`, () => {
    const result = checkedApply(input(JSON.stringify({ effects: row.effects, stateChanges: row.changes }), { makeLocationId: () => "library" }));
    assert.equal(result.character.gold, 18);
    assert.equal(result.applied.gold, 3);
    assert.equal(result.character.hp, row.name === "inventory quantity" ? 34 : 30);
    assert.deepEqual(result.ops.map(op => op.t), row.wantOps);
    if (row.name === "inventory quantity") {
      // Malformed quantity retains the existing default of one, including actual consumption.
      assert.deepEqual(result.ops, [{ t: "inv.update", id: kitId, patch: { quantity: 2 } }]);
      assert.deepEqual(result.applied.inventory, [{ op: "consume", name: "Аптечка", quantity: 1, ok: true }]);
      assert.deepEqual(result.consumedItems, [{ id: kitId, name: "Аптечка", kind: "consumable" }]);
      assert.equal(result.applied.hp, 4);
    }
    if (row.name === "NPC relation") assert.equal(result.applied.npcs[0].delta, 0);
  });
}

// Catches looking each operation up in the initial snapshot, applying requested rather than available quantities, or healing twice after depletion.
test("resolution batch: add, alias consume, oversized remove and rejected consume share the evolving stack", () => {
  const result = checkedApply(input(JSON.stringify({ effects: { hp: -2, xp: 1, gold: -100, danger: 100 }, stateChanges: { inventory: [
    { op: "add", name: " аптечка ", quantity: 2 },
    { op: "consume", ref: "#ABCDEF", name: "Не тот предмет", quantity: 2 },
    { op: "remove", ref: kitId, quantity: 20 },
    { op: "consume", ref: kitId, quantity: 1 },
  ] } })));
  assert.deepEqual(result.ops, [
    { t: "inv.update", id: kitId, patch: { quantity: 5 } },
    { t: "inv.update", id: kitId, patch: { quantity: 3 } },
    { t: "inv.delete", id: kitId },
  ]);
  assert.deepEqual(result.applied.inventory.map(item => ({ op: item.op, quantity: item.quantity, ok: item.ok })), [
    { op: "add", quantity: 2, ok: true }, { op: "consume", quantity: 2, ok: true },
    { op: "remove", quantity: 3, ok: true }, { op: "consume", quantity: 1, ok: false },
  ]);
  assert.equal(result.character.hp, 36); // 30 - 2 + power 4 for each of the two consumed units.
  assert.deepEqual({ hp: result.applied.hp, xp: result.applied.xp, gold: result.applied.gold, danger: result.applied.danger }, { hp: 6, xp: 1, gold: -15, danger: 12 });
  assert.deepEqual(result.applied.resources?.hp, { before: 30, after: 36, maxBefore: 40, maxAfter: 40 });
  assert.deepEqual(result.consumedItems, [{ id: kitId, name: "Аптечка", kind: "consumable" }]);
  assert.equal(result.applied.rejected.length, 1);
});

test("resolution batch: same-turn acquisition, equipment and exhaustion use one generated identity", () => {
  const result = checkedApply(input(JSON.stringify({ effects: { xp: 1 }, stateChanges: { inventory: [
    { op: "add", name: "Плащ", kind: "armor", quantity: 2 },
    { op: "equip", name: "плащ" },
    { op: "unequip", ref: "#fedcba" },
    { op: "remove", name: "ПЛАЩ", quantity: 1 },
    { op: "remove", name: "Плащ", quantity: 20 },
    { op: "equip", name: "Плащ" },
  ] } }), { makeInventoryId: () => "fedcba00-0000-4000-8000-000000000003" }));
  assert.deepEqual(result.ops, [
    { t: "inv.insert", row: { id: "fedcba00-0000-4000-8000-000000000003", name: "Плащ", kind: "armor", description: "", quantity: 2, icon: "🛡️" } },
    { t: "inv.update", id: "fedcba00-0000-4000-8000-000000000003", patch: { equipped: true } },
    { t: "inv.update", id: "fedcba00-0000-4000-8000-000000000003", patch: { equipped: false } },
    { t: "inv.update", id: "fedcba00-0000-4000-8000-000000000003", patch: { quantity: 1 } },
    { t: "inv.delete", id: "fedcba00-0000-4000-8000-000000000003" },
  ]);
  assert.deepEqual(result.applied.inventory.map(item => [item.op, item.quantity, item.ok]), [
    ["add", 2, true], ["equip", 1, true], ["unequip", 1, true], ["remove", 1, true], ["remove", 1, true], ["equip", 1, false],
  ]);
  assert.deepEqual(result.consumedItems, []);
  assert.equal(result.applied.hp, 0);
});

// Catches fallback from an explicit bad/ambiguous ID to a matching name, and first-match selection on duplicate names.
for (const row of [
  { name: "ambiguous prefix", ref: "#abcdef", itemName: "Аптечка" },
  { name: "unowned ID", ref: "#ffffff00-0000-4000-8000-000000000001", itemName: "Аптечка" },
  { name: "short ID", ref: "#abc", itemName: "Аптечка" },
  { name: "duplicate name", ref: "", itemName: "Аптечка" },
]) {
  test(`resolution batch: ${row.name} rejects only that operation and preserves an exact-ID sibling`, () => {
    const value = input(JSON.stringify({ effects: { xp: 1 }, stateChanges: { inventory: [
      { op: "consume", ref: row.ref, name: row.itemName, quantity: 1 },
      { op: "remove", ref: secondId, name: "Аптечка", quantity: 1 },
    ] } }));
    value.inventory.push({ ...value.inventory[0], id: secondId, quantity: 2 });
    const result = checkedApply(value);
    assert.deepEqual(result.ops, [{ t: "inv.update", id: secondId, patch: { quantity: 1 } }]);
    assert.deepEqual(result.applied.inventory.map(item => [item.op, item.quantity, item.ok]), [["consume", 1, false], ["remove", 1, true]]);
    assert.equal(result.character.hp, 30);
    assert.equal(result.applied.hp, 0);
    assert.deepEqual(result.consumedItems, []);
    assert.equal(result.applied.rejected.length, 1);
  });
}
