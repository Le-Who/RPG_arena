import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorldState } from "../src/db/schema";
import { applyLife, emptyLifeChanges, parseLifeChanges, type LifeApplied } from "../src/lib/world-life";
import { applySocial, emptySocialChanges, readSocial } from "../src/lib/world-social";

const world: WorldState = {
  worldName: "Город", tone: "повседневность", era: "сейчас", mainQuest: "", currentLocation: "Кафе", factions: [], flags: {}, danger: 0, chapter: 1,
  commitments: [{ id: "old-dinner", title: "Ужин", parties: ["Олег"], place: "Кафе", due: null, status: "fulfilled", createdTurn: 1, updatedTurn: 2, note: "" }],
};
const npcs = ["Анна", "Олег"].map((name, index) => ({ id: `npc-${index}`, key: `npc-${index}`, name, status: "alive" as const, relation: 0, role: "", description: "", lastLocation: "Кафе" }));

function socialHistory(life: Partial<LifeApplied>, patch: Partial<Parameters<typeof applySocial>[0]> = {}) {
  return readSocial(applySocial({
    world, npcs, locations: [], changes: emptySocialChanges(), intent: "act", turnNumber: 3, startClock: { day: 1, minute: 540 }, startLocation: "Кафе",
    applied: { hp: 0, xp: 0, gold: 0, danger: 0, dead: false, levelUp: false, location: null, npcs: [], quests: [], inventory: [], sceneObjects: [], conditions: { added: [], removed: [] }, rejected: [],
      life: { intent: "act", clock: null, commitments: [], transfers: [], story: null, ...life } }, ...patch,
  }).world).bonds;
}

test("legacy commitment changes use only a unique title and explicit missing IDs never fall back", () => {
  const change = { title: "Ужин", status: "fulfilled" as const, isNew: false };
  assert.deepEqual(socialHistory({ commitments: [change] }).map(bond => bond.name), ["Олег"]);
  assert.deepEqual(socialHistory({ commitments: [{ ...change, id: "unknown-dinner" }] }), []);
  assert.deepEqual(socialHistory({ commitments: [change] }, { world: { ...world, commitments: [...world.commitments!, { ...world.commitments![0], id: "other-dinner", parties: ["Анна"] }] } }), []);
});

test("gift history uses exact NPC identity even when display names collide", () => {
  const twins = [{ ...npcs[0] }, { ...npcs[1], name: "Анна" }];
  const bonds = socialHistory({ transfers: [{ name: "Книга", to: "Анна", quantity: 1, ok: true, holderKind: "npc", holderKey: "npc-1" }] }, { npcs: twins });
  assert.deepEqual(bonds.map(bond => [bond.key, bond.history[0].kind]), [["npc-1", "gift"]]);
});

for (const metadata of [{ holderKind: "npc" as const, holderKey: "missing" }, { holderKind: "location" as const, holderKey: "npc-0" }, { holderKey: "npc-0" }, { holderKind: "npc" as const }]) {
  test(`incomplete or unavailable transfer identity never falls back to the NPC display name: ${JSON.stringify(metadata)}`, () => {
    assert.deepEqual(socialHistory({ transfers: [{ name: "Книга", to: "Анна", quantity: 1, ok: true, ...metadata }] }), []);
  });
}

test("legacy gift history keeps unique NPC names and skips duplicate or cross-kind names", () => {
  const transfers = [{ name: "Книга", to: "Анна", quantity: 1, ok: true }];
  assert.deepEqual(socialHistory({ transfers }).map(bond => bond.key), ["npc-0"]);
  assert.deepEqual(socialHistory({ transfers }, { npcs: [{ ...npcs[0] }, { ...npcs[1], name: "Анна" }] }), []);
  assert.deepEqual(socialHistory({ transfers }, { locations: [{ id: "anna-place", name: "Анна", current: false, discovered: true, x: 1, y: 1, danger: 0 }] }), []);
});

test("a new commitment with a historical title records its actual parties in social history", () => {
  const life = applyLife({
    world, npcs, inventory: [], locations: [], intent: "act", defaultMinutes: 5, turnNumber: 3, touchedItemIds: new Set<string>(), mainQuestCompleted: false,
    life: parseLifeChanges({ commitments: [{ title: "Ужин", parties: ["Анна"], status: "accepted" }] }), makeId: () => "new-dinner",
  });
  assert.equal(life.applied.commitments.length, 1);
  const result = applySocial({
    world: life.world, npcs, locations: [], changes: emptySocialChanges(), intent: "act", turnNumber: 3, startClock: { day: 1, minute: 540 }, startLocation: "Кафе",
    applied: { hp: 0, xp: 0, gold: 0, danger: 0, dead: false, levelUp: false, location: null, npcs: [], quests: [], inventory: [], sceneObjects: [], conditions: { added: [], removed: [] }, rejected: [], life: life.applied },
  });
  assert.deepEqual(readSocial(result.world).bonds.map(bond => [bond.name, bond.history.map(entry => entry.kind)]), [["Анна", ["promise"]]]);
});

test("leaving an item at a location named after an NPC does not record a gift to that NPC", () => {
  const life = applyLife({
    world: { ...world, currentLocation: "Анна" }, npcs, inventory: [{ id: "aaaaaaaa-0000-0000-0000-000000000000", name: "Книга", kind: "misc", quantity: 1, equipped: false, description: "", icon: "", power: 0 }],
    locations: [{ id: "location-anna", name: "Анна", current: true, discovered: true, x: 1, y: 1, danger: 0 }], intent: "act", defaultMinutes: 5, turnNumber: 3, touchedItemIds: new Set<string>(), mainQuestCompleted: false,
    life: { ...emptyLifeChanges(), transfers: [{ ref: "aaaaaaaa-0000-0000-0000-000000000000", to: "location-anna", quantity: 1, accepted: true }] }, makeId: () => "holding-1",
  });
  assert.equal(life.applied.transfers[0]?.ok, true);
  const result = applySocial({
    world: life.world, npcs, locations: [], changes: emptySocialChanges(), intent: "act", turnNumber: 3, startClock: { day: 1, minute: 540 }, startLocation: "Анна",
    applied: { hp: 0, xp: 0, gold: 0, danger: 0, dead: false, levelUp: false, location: null, npcs: [], quests: [], inventory: [], sceneObjects: [], conditions: { added: [], removed: [] }, rejected: [], life: life.applied },
  });
  assert.deepEqual(readSocial(result.world).bonds, []);
});
