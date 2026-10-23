import { test } from "node:test";
import assert from "node:assert/strict";
import { applyResolution, parseResolution, type ApplyInput } from "../src/lib/resolution";
import { createPortableDocument, parsePortableDocument } from "../src/lib/campaign-portable";
import { portableFixture } from "./helpers/portable-fixture";

function input(changes: Record<string, unknown>): ApplyInput {
  return {
    campaignMode: "free", rulesProfile: "narrative", dice: null, turnNumber: 2,
    character: { name: "Ада", archetype: "Горожанка", level: 1, xp: 0, hp: 20, maxHp: 20, gold: 5, stats: {}, skills: [], traits: [], conditions: [], backstory: "", appearance: "" },
    world: { worldName: "Город", tone: "повседневность", era: "наши дни", mainQuest: "", currentLocation: "Кафе", factions: [], flags: {}, danger: 0, chapter: 1 },
    inventory: [], locations: [],
    quests: ["one", "two"].map(key => ({ id: `quest-${key}`, key, title: "Доставить письмо", status: "active", progress: 0, isMain: false, description: "" })),
    npcs: ["one", "two"].map(key => ({ id: `npc-${key}`, key, name: "Александр", status: "alive", relation: 0, role: "сосед", description: "" })),
    sceneObjects: ["one", "two"].map(key => ({ id: `scene-${key}`, key, name: "Дверь", state: "закрыта", locationName: "Кафе", description: "" })),
    payload: parseResolution(JSON.stringify({ stateChanges: changes })).payload,
  };
}

test("a generated scene-object key survives parsing when that object is updated in a later turn", () => {
  const value = input({ sceneObjects: [{ name: "Дверь кабинета директора", state: "закрыта" }] });
  value.world.currentLocation = "Восточное крыло главного административного корпуса";
  value.sceneObjects = [];
  const created = applyResolution(value);
  const insert = created.ops.find(op => op.t === "scene.insert");
  assert.ok(insert && insert.t === "scene.insert");
  assert.ok(insert.row.key.length > 64, "use a real generated key that exceeds the old parser limit");
  const update = parseResolution(JSON.stringify({ stateChanges: { sceneObjects: [{ ref: insert.row.key, name: insert.row.name, state: "открыта" }] } })).payload;
  const result = applyResolution({ ...value, turnNumber: 3, sceneObjects: [{ ...insert.row, id: "generated-scene-object" }], payload: update });
  assert.deepEqual(result.ops, [{ t: "scene.update", id: "generated-scene-object", patch: { state: "открыта", description: undefined } }]);
  assert.deepEqual(result.applied.rejected, []);
});

for (const kind of ["quest", "npc", "scene"] as const) test(`${kind}: a portable key at the 200-character limit remains addressable without a display name`, () => {
  const snapshot = portableFixture();
  const key = "сохранённая-ссылка-" + "д".repeat(181);
  assert.equal(key.length, 200);
  const row = kind === "quest" ? snapshot.quests[0] : kind === "npc" ? snapshot.npcs[0] : snapshot.sceneObjects[0];
  row.key = key;
  const imported = parsePortableDocument(JSON.parse(JSON.stringify(createPortableDocument(snapshot)))).snapshot;
  const changes = kind === "quest" ? { quests: [{ ref: key, progress: 40 }] }
    : kind === "npc" ? { npcs: [{ ref: key, relationDelta: 10 }] }
    : { sceneObjects: [{ ref: key, state: "открыта" }] };
  const value: ApplyInput = { ...input(changes), character: imported.session.character, world: imported.session.worldState,
    quests: imported.quests, npcs: imported.npcs, sceneObjects: imported.sceneObjects };
  const before = structuredClone(value);
  const result = applyResolution(value);
  assert.deepEqual(result.ops.map(op => ({ type: op.t, id: "id" in op ? op.id : null })), [{ type: `${kind}.update`, id: row.id }]);
  assert.deepEqual(result.applied.rejected, []);
  assert.deepEqual(value, before);
});

for (const kind of ["quest", "npc", "scene"] as const) {
  const proposals = (ref: string | null) => kind === "quest" ? { quests: [{ ref, title: "Доставить письмо", progress: 40 }] }
    : kind === "npc" ? { npcs: [{ ref, name: "Александр", relationDelta: 10 }] }
    : { sceneObjects: [{ ref, name: "Дверь", state: "открыта" }] };

  // A matching display name must never outrank the supplied stable entity key.
  test(`${kind}: an exact key selects the intended entity among same-name rows`, () => {
    const value = input(proposals("two")), before = structuredClone(value);
    const result = applyResolution(value);
    assert.deepEqual(result.ops.map(op => ({ type: op.t, id: "id" in op ? op.id : null })), [{ type: `${kind}.update`, id: `${kind}-two` }]);
    assert.deepEqual(result.applied.rejected, []);
    assert.ok(result.events.some(event => event.entityKey.includes("two")));
    assert.deepEqual(value, before);
  });

  for (const row of [{ name: "unknown explicit key", ref: "missing" }, { name: "ambiguous display name", ref: null }]) {
    test(`${kind}: ${row.name} cannot change or invent a namesake entity`, () => {
      const value = input(proposals(row.ref)), before = structuredClone(value);
      const result = applyResolution(value);
      assert.deepEqual(result.ops, []);
      assert.deepEqual(result.events, []);
      assert.equal(result.applied.rejected.length, 1);
      assert.deepEqual(result.applied.quests, []);
      assert.deepEqual(result.applied.npcs, []);
      assert.deepEqual(result.applied.sceneObjects, []);
      assert.deepEqual(value, before);
    });
  }
}
