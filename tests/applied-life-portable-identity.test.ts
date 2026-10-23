import test from "node:test";
import assert from "node:assert/strict";
import { portableFixture, now } from "./helpers/portable-fixture";
import { createPortableDocument, parsePortableDocument } from "../src/lib/campaign-portable";
import { remapSnapshot } from "../src/lib/checkpoint-snapshot";

function snapshotWithLife(identified = true) {
  const snapshot = portableFixture();
  snapshot.turns[0].stateChanges = {
    hp: 0, xp: 0, gold: 0, danger: 0, levelUp: false, dead: false, location: null,
    quests: [], npcs: [], inventory: [], sceneObjects: [], conditions: { added: [], removed: [] }, rejected: [],
    life: {
      intent: "act", clock: null, story: null,
      commitments: [{ ...(identified ? { id: "dinner-anna" } : {}), title: "Ужин", status: "accepted", isNew: true }],
      transfers: [
        { name: "Ключ", to: "Market", quantity: 1, ok: true, ...(identified ? { holderKind: "location" as const, holderKey: snapshot.locations[0].id } : {}) },
        { name: "Подарок", to: "Merchant", quantity: 1, ok: true, ...(identified ? { holderKind: "npc" as const, holderKey: "merchant" } : {}) },
      ],
    },
  };
  return snapshot;
}

for (const identified of [true, false]) test(`portable JSON preserves ${identified ? "identified" : "legacy"} applied commitments and transfers`, () => {
  const snapshot = snapshotWithLife(identified);
  const result = parsePortableDocument(JSON.parse(JSON.stringify(createPortableDocument(snapshot, now))));
  assert.deepEqual(result.snapshot.turns[0].stateChanges!.life, snapshot.turns[0].stateChanges!.life);
});

test("copy remaps applied transfer locations while preserving stable NPC and commitment keys", () => {
  const snapshot = snapshotWithLife();
  const copy = remapSnapshot(snapshot);
  const life = parsePortableDocument(createPortableDocument(copy, now)).snapshot.turns[0].stateChanges!.life!;
  assert.notEqual(copy.locations[0].id, snapshot.locations[0].id);
  assert.equal(life.transfers[0].holderKey, copy.locations[0].id);
  assert.equal(life.transfers[1].holderKey, "merchant");
  assert.equal(life.commitments[0].id, "dinner-anna");
  assert.equal(snapshot.turns[0].stateChanges!.life!.transfers[0].holderKey, snapshot.locations[0].id);
});

test("portable transfer provenance and holdings retain a full persisted NPC key", () => {
  const snapshot = snapshotWithLife();
  const npcKey = "n".repeat(200);
  snapshot.npcs[0].key = npcKey;
  snapshot.turns[0].stateChanges!.life!.transfers[1].holderKey = npcKey;
  snapshot.session.worldState.holdings = [{ id: "gift", name: "Подарок", description: "", quantity: 1, holderKind: "npc", holderKey: npcKey, holderName: "Merchant", turn: 1 }];
  const copy = remapSnapshot(parsePortableDocument(createPortableDocument(snapshot, now)).snapshot);
  const parsed = parsePortableDocument(createPortableDocument(copy, now)).snapshot;
  assert.equal(parsed.npcs[0].key, npcKey);
  assert.equal(parsed.turns[0].stateChanges!.life!.transfers[1].holderKey, npcKey);
  assert.equal(parsed.session.worldState.holdings![0].holderKey, npcKey);
});

test("portable world references retain a full persisted NPC key", () => {
  const snapshot = snapshotWithLife(false);
  const key = "n".repeat(200);
  snapshot.npcs[0].key = key;
  const world = snapshot.session.worldState;
  world.agenda = [{ id: "visit", title: "Визит", kind: "npc", npcKey: key, npcName: "Merchant", at: { day: 2, minute: 600 }, note: "", status: "pending", createdTurn: 1 }];
  world.npcAgendas = [{ key, name: "Merchant", goal: "Встреча", routine: "Утром", updatedTurn: 1 }];
  world.npcBonds = [{ key, name: "Merchant", updatedTurn: 1, history: [], knows: [] }];
  world.npcSchedules = [{ id: "morning", npcKey: key, npcName: "Merchant", place: "Market", from: 600, to: 660, repeat: "daily", day: null, note: "", createdTurn: 1 }];
  const parsed = parsePortableDocument(createPortableDocument(snapshot, now)).snapshot.session.worldState;
  assert.equal(parsed.agenda![0].npcKey, key);
  assert.equal(parsed.npcAgendas![0].key, key);
  assert.equal(parsed.npcBonds![0].key, key);
  assert.equal(parsed.npcSchedules![0].npcKey, key);
});

test("portable history preserves existing commitment IDs and rejected full-key transfer targets", () => {
  const snapshot = snapshotWithLife();
  const id = "c".repeat(64), unknownTarget = "u".repeat(200);
  snapshot.session.worldState.commitments = [{ id, title: "Ужин", parties: ["Merchant"], place: "Market", due: null, status: "accepted", createdTurn: 1, updatedTurn: 1, note: "" }];
  const applied = snapshot.turns[0].stateChanges!.life!;
  applied.commitments[0].id = id;
  applied.transfers.push({ name: "Ключ", to: unknownTarget, quantity: 1, ok: false, reason: "Получатель не найден" });
  const parsed = parsePortableDocument(createPortableDocument(snapshot, now)).snapshot;
  assert.equal(parsed.turns[0].stateChanges!.life!.commitments[0].id, id);
  assert.equal(parsed.turns[0].stateChanges!.life!.transfers[2].to, unknownTarget);
});

test("applied life identity extension retains strict bounds and the unknown-field allowlist", () => {
  for (const patch of [
    { id: "x".repeat(65) },
    { holderKind: "account" },
    { holderKey: "x".repeat(201) },
    { ownerId: "foreign-profile" },
  ]) {
    const snapshot = snapshotWithLife();
    Object.assign("id" in patch ? snapshot.turns[0].stateChanges!.life!.commitments[0] : snapshot.turns[0].stateChanges!.life!.transfers[0], patch);
    assert.throws(() => createPortableDocument(snapshot, now), { code: "INVALID_DOCUMENT" });
  }
});
