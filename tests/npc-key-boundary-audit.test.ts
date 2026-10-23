import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { applyResolution, parseResolution } from "../src/lib/resolution";
import { applyLife, readLife } from "../src/lib/world-life";
import { applyAgenda, readAgenda } from "../src/lib/world-agenda";
import { applySocial, editSocial, parseSocialEdit, readSocial } from "../src/lib/world-social";
import { createPortableDocument, parsePortableDocument } from "../src/lib/campaign-portable";
import { portableFixture } from "./helpers/portable-fixture";

const prefix = "npc-" + "a".repeat(76);
const npcKey = prefix + "b".repeat(120);
const narration = "Анна получила ключ и узнала, что герой ищет брата. Она работает в Market с девяти до двенадцати и хочет открыть пекарню. Через час Анна вернётся в Market.";

function fixture() {
  const snapshot = portableFixture();
  snapshot.npcs[0] = { ...snapshot.npcs[0], key: npcKey, name: "Анна" };
  snapshot.npcs.push({ ...snapshot.npcs[0], id: randomUUID(), key: prefix, name: "Другой персонаж" });
  return snapshot;
}

function proposals(itemId: string) {
  return parseResolution(JSON.stringify({ narration, stateChanges: {
    transfers: [{ ref: itemId, to: npcKey, quantity: 1, accepted: true }],
    events: [{ title: "Визит Анны", kind: "npc", npc: npcKey, inMinutes: 60, evidence: narration }],
    npcGoals: [{ npc: npcKey, goal: "Открыть пекарню", evidence: narration }],
    npcSchedule: [{ npc: npcKey, place: "Market", from: "09:00", to: "12:00", evidence: narration }],
    npcKnowledge: [{ npc: npcKey, fact: "Герой ищет брата", evidence: narration }],
  } })).payload;
}

for (const [name, reference] of [
  ["transfer", () => proposals("aaaaaaaa-0000-0000-0000-000000000000").life!.transfers[0].to],
  ["event", () => proposals("").agenda!.events[0].npc],
  ["goal", () => proposals("").agenda!.npcGoals[0].npc],
  ["schedule", () => proposals("").social!.schedule[0].npc],
  ["knowledge", () => proposals("").social!.knowledge[0].npc],
] as const) {
  test(`generated ${name} preserves an exact 200-character NPC key`, () => assert.equal(reference(), npcKey));
}

test("long NPC identity survives generated life, agenda and social state through portable JSON", () => {
  const snapshot = fixture();
  const beforeWorld = snapshot.session.worldState;
  const payload = proposals(snapshot.inventory[0].id);
  const resolution = applyResolution({ rulesProfile: "rules-light", campaignMode: "free", character: snapshot.session.character, world: beforeWorld,
    inventory: snapshot.inventory, quests: snapshot.quests, npcs: snapshot.npcs, sceneObjects: snapshot.sceneObjects, locations: snapshot.locations,
    payload, dice: null, turnNumber: 2 });
  const life = applyLife({ world: resolution.world, inventory: snapshot.inventory, npcs: snapshot.npcs, locations: snapshot.locations, life: payload.life!, intent: "act", defaultMinutes: 5,
    turnNumber: 2, touchedItemIds: new Set<string>(), mainQuestCompleted: false });
  assert.equal(life.applied.transfers[0]?.holderKey, npcKey, "the 80-character sibling cannot receive the item");
  const agenda = applyAgenda({ world: life.world, npcs: snapshot.npcs, changes: payload.agenda!, intent: "act", turnNumber: 2, narration, startClock: readLife(beforeWorld).clock });
  const applied = { ...resolution.applied, life: life.applied, agenda: agenda.applied };
  const social = applySocial({ world: agenda.world, npcs: snapshot.npcs, locations: snapshot.locations, applied, changes: payload.social!, intent: "act", turnNumber: 2, narration,
    startClock: readLife(beforeWorld).clock, startLocation: beforeWorld.currentLocation });
  assert.deepEqual([...life.rejected, ...agenda.rejected, ...social.rejected], []);
  snapshot.session.worldState = social.world;
  snapshot.inventory = [];
  snapshot.turns[0].stateChanges = { ...applied, social: social.applied };
  const restored = parsePortableDocument(JSON.parse(JSON.stringify(createPortableDocument(snapshot)))).snapshot;
  const saved = restored.session.worldState;
  assert.deepEqual(readLife(saved).holdings.map(holding => holding.holderKey), [npcKey]);
  assert.deepEqual(readAgenda(saved).events.map(event => event.npcKey), [npcKey]);
  assert.deepEqual(readAgenda(saved).npcAgendas.map(agenda => agenda.key), [npcKey]);
  assert.deepEqual(readSocial(saved).bonds.map(bond => [bond.key, bond.history.map(entry => entry.kind)]), [[npcKey, ["gift", "knowledge"]]]);
  assert.deepEqual(readSocial(saved).schedules.map(slot => slot.npcKey), [npcKey]);
});

for (const edit of [
  { op: "knowledge.add", npcKey, text: "Герой ищет брата" },
  { op: "knowledge.remove", npcKey, index: 0, expected: { text: "Герой ищет брата", turn: 1, source: "scene" } },
  { op: "schedule.upsert", npcKey, place: "Market", from: "09:00", to: "12:00", repeat: "daily", day: null },
]) {
  test(`owner ${edit.op} accepts a canonical NPC key at its existing bound`, () => {
    const parsed = parseSocialEdit(edit);
    assert.ok(parsed);
    assert.equal("npcKey" in parsed ? parsed.npcKey : null, npcKey);
    if (parsed.op === "knowledge.remove") return;
    const snapshot = fixture();
    const result = editSocial({ world: snapshot.session.worldState, npcs: snapshot.npcs, locations: snapshot.locations, edit: parsed, turn: 2 });
    assert.ok(result.ok);
    const social = readSocial(result.world);
    assert.equal(parsed.op === "knowledge.add" ? social.bonds[0]?.key : social.schedules[0]?.npcKey, npcKey);
  });
}

test("an existing portable commitment ID at its 64-character bound remains addressable and exportable", () => {
  const snapshot = fixture();
  const id = "c".repeat(64);
  snapshot.session.worldState.commitments = [{ id, title: "Обед", parties: ["Анна"], place: "Market", due: null, status: "accepted", createdTurn: 1, updatedTurn: 1, note: "" }];
  const payload = parseResolution(JSON.stringify({ stateChanges: { commitments: [{ ref: id, status: "fulfilled" }] } })).payload;
  const resolution = applyResolution({ rulesProfile: "rules-light", campaignMode: "free", character: snapshot.session.character, world: snapshot.session.worldState,
    inventory: snapshot.inventory, quests: snapshot.quests, npcs: snapshot.npcs, sceneObjects: snapshot.sceneObjects, locations: snapshot.locations, payload, dice: null, turnNumber: 2 });
  const life = applyLife({ world: resolution.world, inventory: snapshot.inventory, npcs: snapshot.npcs, locations: snapshot.locations, life: payload.life!, intent: "act", defaultMinutes: 5,
    turnNumber: 2, touchedItemIds: new Set<string>(), mainQuestCompleted: false });
  assert.deepEqual(life.rejected, []);
  assert.equal(life.applied.commitments[0]?.id, id);
  snapshot.session.worldState = life.world;
  snapshot.turns[0].stateChanges = { ...resolution.applied, life: life.applied };
  const restored = parsePortableDocument(JSON.parse(JSON.stringify(createPortableDocument(snapshot)))).snapshot;
  assert.equal(readLife(restored.session.worldState).commitments[0].status, "fulfilled");
  assert.equal(restored.turns[0].stateChanges?.life?.commitments[0].id, id);
});
