import { test } from "node:test";
import assert from "node:assert/strict";
import { applyResolution, parseResolution, type ApplyInput } from "../src/lib/resolution";
import { executeLocationOp } from "../src/lib/location-ops";
import { visibleMapLocations } from "../src/lib/world-graph";

const UUID_A = "10000000-0000-4000-8000-000000000001";
const UUID_B = "10000000-0000-4000-8000-000000000002";

function input(payload: ApplyInput["payload"], locations: ApplyInput["locations"] = [
  { id: "00000000-0000-4000-8000-000000000001", name: "Площадь", x: 5, y: 5, current: true, discovered: true, danger: 10, connectedTo: [] },
]): ApplyInput {
  const ids = [UUID_A, UUID_B];
  return {
    rulesProfile: "d20", campaignMode: "free",
    character: { name: "Ада", archetype: "Следователь", level: 1, xp: 0, hp: 30, maxHp: 30, gold: 0, stats: {}, skills: [], traits: [], backstory: "", appearance: "", conditions: [] },
    world: { worldName: "Город", tone: "нуар", era: "1950", mainQuest: "", currentLocation: "Площадь", factions: [], flags: {}, danger: 10, chapter: 1 },
    inventory: [], quests: [], npcs: [], sceneObjects: [], locations, payload, dice: null, turnNumber: 2,
    makeLocationId: () => ids.shift()!,
  };
}

test("map discovery parser keeps legacy location and normalizes optional plural topology", () => {
  const legacy = parseResolution(JSON.stringify({ stateChanges: { location: { action: "discover", name: "Док" } } })).payload;
  assert.equal(legacy.stateChanges.location?.name, "Док");
  assert.equal(legacy.stateChanges.location?.ref, null);
  assert.deepEqual(legacy.stateChanges.locations, []);
  assert.deepEqual(legacy.stateChanges.routes, []);

  const payload = parseResolution(JSON.stringify({ stateChanges: {
    locations: [{ name: "Док", description: "У воды", danger: 150 }, { ref: "known-id", name: "" }],
    routes: [{ from: "Площадь", to: "Док" }, { from: "", to: "Док" }],
  } })).payload;
  assert.deepEqual(payload.stateChanges.locations, [
    { ref: null, name: "Док", description: "У воды", danger: 100 },
    { ref: "known-id", name: "", description: "", danger: null },
  ]);
  assert.deepEqual(payload.stateChanges.routes, [{ from: "Площадь", to: "Док" }]);
});

test("map discovery parser ignores null and scalar topology entries", () => {
  const payload = parseResolution(JSON.stringify({ stateChanges: {
    locations: [null, 7, "Док", { name: "Башня" }],
    routes: [null, false, "Площадь — Башня", { from: "Площадь", to: "Башня" }],
  } })).payload;
  assert.deepEqual(payload.stateChanges.locations, [{ ref: null, name: "Башня", description: "", danger: null }]);
  assert.deepEqual(payload.stateChanges.routes, [{ from: "Площадь", to: "Башня" }]);
});

test("reducer discovers several places with unique IDs/positions and writes only explicit routes", () => {
  const payload = parseResolution(JSON.stringify({ stateChanges: {
    locations: [{ name: "Док", description: "У воды" }, { name: "Башня", description: "Над городом" }],
    routes: [{ from: "Площадь", to: "Док" }],
  } })).payload;
  const result = applyResolution(input(payload));
  const inserts = result.ops.filter((op) => op.t === "loc.insert");
  assert.deepEqual(inserts.map((op) => op.row.id), [UUID_A, UUID_B]);
  assert.notDeepEqual([inserts[0].row.x, inserts[0].row.y], [inserts[1].row.x, inserts[1].row.y]);
  assert.deepEqual(result.ops.filter((op) => op.t === "loc.connect"), [{
    t: "loc.connect", fromId: "00000000-0000-4000-8000-000000000001", toId: UUID_A,
  }]);
});

test("reducer records successful movement as a bidirectional route", () => {
  const payload = parseResolution(JSON.stringify({ stateChanges: { location: { action: "move", name: "Док" } } })).payload;
  const locations = input(payload).locations.concat({ id: UUID_A, name: "Док", x: 8, y: 5, current: false, discovered: true, danger: 20, connectedTo: [] });
  const result = applyResolution(input(payload, locations));
  assert.ok(result.ops.some((op) => op.t === "loc.setCurrent" && op.id === UUID_A));
  assert.ok(result.ops.some((op) => op.t === "loc.connect" && op.fromId === locations[0].id && op.toId === UUID_A));
});

test("movement resolves an explicit ID before comparing duplicate location names", () => {
  const currentId = "00000000-0000-4000-8000-000000000001";
  const payload = parseResolution(JSON.stringify({ stateChanges: { location: { action: "move", ref: UUID_A, name: "Ворота" } } })).payload;
  const locations = [
    { id: currentId, name: "Ворота", x: 5, y: 5, current: true, discovered: true, danger: 10, connectedTo: [] },
    { id: UUID_A, name: "Ворота", x: 8, y: 5, current: false, discovered: true, danger: 20, connectedTo: [] },
  ];
  const result = applyResolution({ ...input(payload, locations), world: { ...input(payload, locations).world, currentLocation: "Ворота" } });
  assert.ok(result.ops.some((op) => op.t === "loc.setCurrent" && op.id === UUID_A));
  assert.ok(result.ops.some((op) => op.t === "loc.connect" && op.fromId === currentId && op.toId === UUID_A));
});

test("first reveal of an existing hidden location emits canonical discovery memory once", () => {
  const hidden = { id: UUID_A, name: "Старая башня", x: 8, y: 5, current: false, discovered: false, danger: 20, connectedTo: [] };
  const payload = parseResolution(JSON.stringify({ stateChanges: { locations: [{ ref: UUID_A, name: "Ошибочное имя", description: "Видна над туманом" }] } })).payload;
  const first = applyResolution(input(payload, input(payload).locations.concat(hidden)));
  assert.ok(first.ops.some((op) => op.t === "loc.discover" && op.id === UUID_A));
  assert.ok(first.events.some((event) => event.entityKey === "location:старая-башня" && event.content.includes("Видна над туманом")));

  const alreadyVisible = applyResolution(input(payload, input(payload).locations.concat({ ...hidden, discovered: true })));
  assert.ok(!alreadyVisible.events.some((event) => event.entityKey === "location:старая-башня"));
});

test("reducer rejects foreign IDs and ambiguous names without inventing a route", () => {
  const payload = parseResolution(JSON.stringify({ stateChanges: { routes: [
    { from: "foreign-id", to: "Площадь" }, { from: "Ворота", to: "Площадь" },
  ] } })).payload;
  const locations = input(payload).locations.concat(
    { id: UUID_A, name: "Ворота", x: 2, y: 2, current: false, discovered: true, danger: 20, connectedTo: [] },
    { id: UUID_B, name: "Ворота", x: 3, y: 3, current: false, discovered: true, danger: 20, connectedTo: [] },
  );
  const result = applyResolution(input(payload, locations));
  assert.equal(result.ops.filter((op) => op.t === "loc.connect").length, 0);
  assert.equal(result.applied.rejected.filter((reason) => /маршрут/i.test(reason)).length, 2);
});

test("movement by an explicit foreign location reference fails closed", () => {
  const payload = parseResolution(JSON.stringify({ stateChanges: { location: { action: "move", ref: "foreign-id", name: "Подмена" } } })).payload;
  const result = applyResolution(input(payload));
  assert.equal(result.world.currentLocation, "Площадь");
  assert.equal(result.ops.filter((op) => op.t.startsWith("loc.")).length, 0);
  assert.ok(result.applied.rejected.some((reason) => reason.includes("foreign-id")));
});

test("location executor persists both directions without duplicates", async () => {
  const rows = new Map([
    [UUID_A, { id: UUID_A, connectedTo: [] as string[] }],
    [UUID_B, { id: UUID_B, connectedTo: [UUID_A] }],
  ]);
  const updates: { id: string; connectedTo: string[] }[] = [];
  const tx = {
    select: () => ({ from: () => ({ where: async () => [...rows.values()] }) }),
    update: () => ({ set: (patch: { connectedTo: string[] }) => ({ where: async () => {
      const id = updates.length === 0 ? UUID_A : UUID_B;
      updates.push({ id, connectedTo: patch.connectedTo });
    } }) }),
  };
  await executeLocationOp(tx as never, "session", { t: "loc.connect", fromId: UUID_A, toId: UUID_B });
  assert.deepEqual(updates, [
    { id: UUID_A, connectedTo: [UUID_B] },
    { id: UUID_B, connectedTo: [UUID_A] },
  ]);
});

test("direct map consumers receive discovered locations only", () => {
  const visible = visibleMapLocations([
    { id: UUID_A, name: "Открыто", x: 1, y: 1, discovered: true },
    { id: UUID_B, name: "Секрет", x: 2, y: 2, discovered: false },
  ]);
  assert.deepEqual(visible.map((location) => location.id), [UUID_A]);
});
