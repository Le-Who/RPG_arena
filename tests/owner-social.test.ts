import test from "node:test";
import assert from "node:assert/strict";
import { editSocial, parseSocialEdit, readSocial, type SocialEdit } from "../src/lib/world-social";
import { portableFixture } from "./helpers/portable-fixture";
import { createPortableDocument, parsePortableDocument } from "../src/lib/campaign-portable";
import { remapSnapshot } from "../src/lib/checkpoint-snapshot";
const world = (): import("../src/db/schema").WorldState => ({ ...portableFixture().session.worldState, clock: { day: 2, minute: 60 } });
const npc = { key: "anna", name: "Анна", status: "alive" as const };
const run = (edit: unknown, state = world()) => editSocial({ world: state, npcs: [npc], locations: [{ name: "Дом" }], edit: edit as SocialEdit, turn: 3 });
const slot = { op: "schedule.upsert", npcKey: "anna", place: "Дом", from: "22:00", to: "02:00", repeat: "once", day: 1 };
test("owner parser rejects invalid enums, oversize values, unknown fields and missing preconditions", () => {
  for (const invalid of [{ ...slot, repeat: "weekly" }, { ...slot, day: 1000001 }, { ...slot, note: "x".repeat(201) }, { ...slot, from: "22:00junk" }, { ...slot, extra: true }, { op: "knowledge.remove", npcKey: "anna", index: 0 }, { op: "schedule.remove", id: "a" }]) assert.equal(parseSocialEdit(invalid), null);
});
test("owner schedule allows active overnight and rejects expired or unknown place", () => {
  assert.equal(run(slot).ok, true);
  assert.equal(run({ ...slot, from: "00:00", to: "00:30", day: 2 }).ok, false);
  assert.equal(run({ ...slot, repeat: "daily", day: null, place: "Неизвестно" }).ok, false);
});
test("knowledge removal checks text, turn and provenance, and never asserts ignorance", () => {
  const state = { ...world(), npcBonds: [{ key: "anna", name: "Анна", updatedTurn: 2, history: [], knows: [{ text: "А", turn: 1 }, { text: "Б", turn: 2 }] }] };
  const before = structuredClone(state);
  const edit = { op: "knowledge.remove", npcKey: "anna", index: 0, expected: { text: "А", turn: 1, source: "scene" } };
  const first = run(edit, state);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(run(edit, first.world).ok, false);
  assert.match(first.events[0].content, /снята/);
  assert.doesNotMatch(first.events[0].content, /не знает/);
  assert.deepEqual(state, before);
  assert.equal(readSocial(first.world).bonds[0].knows[0].text, "Б");
});
test("owner limits reject additions without evicting knowledge or bonds", () => {
  const state = { ...world(), npcBonds: [{ key: "anna", name: "Анна", updatedTurn: 2, history: [], knows: Array.from({ length: 8 }, (_, i) => ({ text: `Факт ${i}`, turn: 1 })) }] };
  assert.equal(run({ op: "knowledge.add", npcKey: "anna", text: "Новый" }, state).ok, false);
  const full = { ...world(), npcBonds: Array.from({ length: 40 }, (_, i) => ({ key: `n${i}`, name: `n${i}`, updatedTurn: 1, history: [], knows: [] })) };
  assert.equal(run({ op: "knowledge.add", npcKey: "anna", text: "Новый" }, full).ok, false);
  const schedules = { ...world(), npcSchedules: Array.from({ length: 4 }, (_, i) => ({ id: `slot${i}`, npcKey: "anna", npcName: "Анна", place: "Дом", from: i * 120, to: i * 120 + 60, repeat: "daily" as const, day: null, note: "", createdTurn: 1 })) };
  const before = structuredClone(schedules);
  assert.equal(run({ ...slot, repeat: "daily", day: null, from: "10:00", to: "11:00" }, schedules).ok, false);
  assert.deepEqual(schedules, before);
});

test("portable JSON and copy retain owner provenance and legacy scene defaults with strict validation", () => {
  const snapshot = portableFixture();
  const knowledge = run({ op: "knowledge.add", npcKey: "anna", text: "Ключ у героя" });
  assert.ok(knowledge.ok);
  const scheduled = run({ ...slot, repeat: "daily", day: null }, knowledge.world);
  assert.ok(scheduled.ok);
  snapshot.session.worldState = scheduled.world;
  const document = createPortableDocument(snapshot);
  const copy = remapSnapshot(parsePortableDocument(JSON.parse(JSON.stringify(document))).snapshot);
  assert.equal(copy.session.worldState.npcBonds![0].knows[0].source, "owner");
  assert.equal(copy.session.worldState.npcSchedules![0].source, "owner");
  assert.notEqual(copy.session.id, snapshot.session.id);
  for (const invalid of ["invented", "x".repeat(1000)]) {
    const bad = structuredClone(document);
    Object.assign(bad.snapshot.session.worldState.npcBonds![0].knows[0], { source: invalid });
    assert.throws(() => parsePortableDocument(bad), /document/);
  }
  const unknown = structuredClone(document);
  Object.assign(unknown.snapshot.session.worldState.npcSchedules![0], { extra: true });
  assert.throws(() => parsePortableDocument(unknown), /document/);
  delete snapshot.session.worldState.npcBonds![0].knows[0].source;
  delete snapshot.session.worldState.npcSchedules![0].source;
  assert.doesNotThrow(() => createPortableDocument(snapshot));
  assert.equal(readSocial(snapshot.session.worldState).bonds[0].knows[0].source ?? "scene", "scene");
});
