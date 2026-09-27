import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppliedChanges, WorldState } from "../src/db/schema";
import { applyLife, emptyLifeChanges, readLife, type Commitment } from "../src/lib/world-life";
import { applySocial, buildSocialPromptBlock, emptySocialChanges, npcPresence, parseSocialChanges, placeMatches, readSocial, slotActive, type SocialChanges } from "../src/lib/world-social";
import { createPortableDocument, parsePortableDocument } from "../src/lib/campaign-portable";
import { portableFixture } from "./helpers/portable-fixture";

const world = (patch: Partial<WorldState> = {}): WorldState => ({
  worldName: "Город", tone: "повседневность", era: "наши дни", mainQuest: "", currentLocation: "Пекарня",
  factions: [], flags: {}, danger: 0, chapter: 1, clock: { day: 1, minute: 8 * 60 }, ...patch,
});
const anna = { id: "11111111-1111-4111-8111-111111111111", key: "anna", name: "Анна", role: "пекарь", relation: 10, status: "alive" as const, description: "", lastLocation: "Пекарня" };
const oleg = { id: "22222222-2222-4222-8222-222222222222", key: "oleg", name: "Олег", role: "моряк", relation: 0, status: "alive" as const, description: "", lastLocation: "Порт" };
const locs = [
  { id: "l1", name: "Пекарня", x: 0, y: 0, current: true, discovered: true, danger: 0, connectedTo: [] },
  { id: "l2", name: "Порт", x: 1, y: 0, current: false, discovered: true, danger: 0, connectedTo: [] },
  { id: "l3", name: "Кафе", x: 2, y: 0, current: false, discovered: true, danger: 0, connectedTo: [] },
];
const applied = (patch: Partial<AppliedChanges> = {}): AppliedChanges => ({
  hp: 0, xp: 0, gold: 0, danger: 0, levelUp: false, dead: false, location: null, quests: [], npcs: [], inventory: [], sceneObjects: [],
  conditions: { added: [], removed: [] }, rejected: [], ...patch,
});
const run = (patch: Partial<Parameters<typeof applySocial>[0]> = {}) => applySocial({
  world: world(), startClock: { day: 1, minute: 8 * 60 }, startLocation: "Пекарня", npcs: [{ ...anna }, { ...oleg }], locations: locs,
  applied: applied(), changes: emptySocialChanges(), intent: "act", turnNumber: 5, makeId: () => "slot1", ...patch,
});
const narration = "Анна вытерла руки: «Я здесь каждый день с семи до трёх, потом ухожу на рынок».";
const annaSchedule = (patch: Partial<SocialChanges["schedule"][number]> = {}): SocialChanges => ({
  schedule: [{ npc: "anna", place: "пекарня", from: "07:00", to: "15:00", repeat: "daily", day: null, note: "", remove: false, evidence: "Я здесь каждый день с семи до трёх", ...patch }],
  knowledge: [],
});
const dinner = (patch: Partial<Commitment> = {}): Commitment => ({
  id: "c1", title: "Ужин с Анной", parties: ["Анна"], place: "Кафе", due: { day: 1, minute: 19 * 60 }, status: "accepted", createdTurn: 2, updatedTurn: 2, note: "", ...patch,
});

test("a schedule revealed by the scene becomes a structured slot; presence is computed from the world clock", () => {
  const result = run({ changes: annaSchedule(), narration });
  assert.deepEqual(result.rejected, []);
  const [slot] = readSocial(result.world).schedules;
  assert.equal(slot.place, "Пекарня", "place is canonicalised to the known location");
  assert.deepEqual([slot.from, slot.to, slot.repeat], [420, 900, "daily"]);
  assert.equal(npcPresence(result.world, [anna, oleg]).here[0]?.name, "Анна");
  const evening = npcPresence({ ...result.world, clock: { day: 1, minute: 16 * 60 } }, [anna, oleg]);
  assert.equal(evening.here.length, 0);
  assert.match(evening.later[0].hint, /завтра с 07:00/);
  assert.match(buildSocialPromptBlock(result.world, [anna, oleg]), /здесь сейчас — "Анна"/);
  assert.match(result.applied.schedules[0].window, /07:00–15:00, ежедневно/);
});

test("unconfirmed, claimed, malformed or ambiguous schedules are rejected", () => {
  assert.match(run({ changes: annaSchedule({ evidence: "она всегда тут" }), narration }).rejected[0], /не подтверждён/);
  assert.match(run({ changes: annaSchedule(), narration, intent: "claim" }).rejected[0], /догадка/);
  assert.match(run({ changes: annaSchedule({ from: "25:00" }), narration }).rejected[0], /неверном формате/);
  assert.match(run({ changes: annaSchedule({ repeat: "once", day: null }), narration }).rejected[0], /разового окна/);
  const twins = [{ ...anna, id: "a1", key: "a1", name: "Анна Петрова" }, { ...anna, id: "a2", key: "a2", name: "Анна Сидорова" }];
  assert.match(run({ npcs: twins, changes: annaSchedule({ npc: "Анна" }), narration }).rejected[0], /неоднозначен/);
  assert.deepEqual(readSocial(run({ changes: annaSchedule({ evidence: "нет цитаты" }), narration }).world).schedules, []);
});

test("overnight and one-off windows, and place matching by whole words", () => {
  const night = { from: 22 * 60, to: 2 * 60, repeat: "daily" as const, day: null };
  assert.equal(slotActive(night, { day: 3, minute: 60 }), true);
  assert.equal(slotActive(night, { day: 3, minute: 12 * 60 }), false);
  const once = { from: 22 * 60, to: 2 * 60, repeat: "once" as const, day: 2 };
  assert.equal(slotActive(once, { day: 3, minute: 60 }), true);
  assert.equal(slotActive(once, { day: 4, minute: 60 }), false);
  assert.equal(placeMatches("Порт", "Портовый рынок"), false);
  assert.equal(placeMatches("Пекарня", "Пекарня Анны"), true);
  assert.equal(placeMatches("пекарня", "Пекарня"), true);
});

test("bonds explain relation changes with reason and source turn; knowledge requires narrative evidence", () => {
  const result = run({
    applied: applied({
      npcs: [{ name: "Анна", relation: 15, delta: 5, status: "alive", isNew: false, note: "герой помог донести муку" }],
      life: { intent: "act", clock: null, commitments: [], transfers: [{ name: "Шарф", to: "Анна", quantity: 1, ok: true }], story: null },
    }),
    changes: { schedule: [], knowledge: [{ npc: "Анна", fact: "герой ищет брата", evidence: "Значит, ты ищешь брата" }] },
    narration: "Анна кивнула: «Значит, ты ищешь брата».",
  });
  const bond = readSocial(result.world).bonds.find((b) => b.key === "anna")!;
  assert.deepEqual(bond.history.map((h) => h.kind), ["relation", "gift", "knowledge"]);
  assert.deepEqual([bond.history[0].text, bond.history[0].delta, bond.history[0].turn], ["герой помог донести муку", 5, 5]);
  assert.deepEqual(bond.knows.map((k) => k.text), ["герой ищет брата"]);
  const unconfirmed = run({ changes: { schedule: [], knowledge: [{ npc: "Анна", fact: "герой богат", evidence: "выдуманная цитата" }] }, narration: "Анна молчит." });
  assert.match(unconfirmed.rejected[0], /не подтверждено/);
  assert.deepEqual(readSocial(unconfirmed.world).bonds, []);
});

test("overdue meetings are visible without inferring absence or changing relationships", () => {
  for (const place of ["Кафе", ""]) {
    const result = run({ world: world({ currentLocation: "Дом", clock: { day: 1, minute: 21 * 60 }, commitments: [dinner({ place, missEffect: "relation" })] }),
      startClock: { day: 1, minute: 19 * 60 + 30 }, startLocation: "Дом" });
    assert.equal(readLife(result.world).commitments[0].status, "accepted");
    assert.equal(readLife(result.world).commitments[0].attendance, undefined);
    assert.deepEqual(result.ops, []);
    assert.deepEqual(result.applied.missed, []);
    assert.equal(result.applied.overdue.length, 1);
    assert.match(result.applied.overdue[0].reason, /не подтверждены/);
  }
  const late = run({ world: world({ currentLocation: "Дом", clock: { day: 1, minute: 19 * 60 + 40 }, commitments: [dinner()] }), startClock: { day: 1, minute: 19 * 60 + 10 } });
  assert.deepEqual(late.applied.overdue, []);
});

test("rescheduling is a distinct outcome: history keeps the old time and attendance is reset", () => {
  const before = world({ currentLocation: "Дом", clock: { day: 1, minute: 18 * 60 }, commitments: [dinner({ attendance: "absent" })] });
  const moved = applyLife({
    world: before, inventory: [], npcs: [anna], locations: locs, intent: "act", defaultMinutes: 10, turnNumber: 6, touchedItemIds: new Set(), mainQuestCompleted: false,
    life: { ...emptyLifeChanges(), commitments: [{ ref: "c1", title: "Ужин с Анной", parties: [], place: "", day: 2, time: "19:00", status: "accepted", note: "перенесли на завтра" }] },
  });
  const commitment = readLife(moved.world).commitments[0];
  assert.deepEqual(commitment.due, { day: 2, minute: 19 * 60 });
  assert.deepEqual(commitment.history?.[0], { turn: 6, kind: "rescheduled", from: { day: 1, minute: 19 * 60 }, to: { day: 2, minute: 19 * 60 } });
  assert.equal(commitment.attendance, undefined);
  assert.equal(moved.applied.commitments[0].rescheduled, true);
  const evening = run({ world: { ...moved.world, clock: { day: 1, minute: 21 * 60 } }, startClock: { day: 1, minute: 18 * 60 + 10 }, startLocation: "Дом", turnNumber: 7 });
  assert.equal(readLife(evening.world).commitments[0].status, "accepted");
});

test("model proposals are parsed defensively", () => {
  const parsed = parseSocialChanges({
    npcSchedule: [{ npc: "anna", place: "Пекарня", from: "07:00", to: "15:00", repeat: "once", day: "3", evidence: "x" }, { npc: "oleg" }, "junk"],
    npcKnowledge: [{ npc: "oleg", fact: "герой моряк", evidence: "…" }, { npc: "", fact: "?" }],
  });
  assert.equal(parsed.schedule.length, 1);
  assert.deepEqual([parsed.schedule[0].repeat, parsed.schedule[0].day], ["once", 3]);
  assert.deepEqual(parsed.knowledge.map((k) => k.npc), ["oleg"]);
});

test("portable JSON keeps people, schedules, arc history and new applied fields, and still rejects unknown keys", () => {
  const snapshot = portableFixture();
  const clock = () => ({ day: 1, minute: 19 * 60 });
  snapshot.session.worldState = {
    ...snapshot.session.worldState,
    commitments: [{ id: "c1", title: "Ужин", parties: ["Merchant"], place: "Market", due: clock(), status: "broken", createdTurn: 1, updatedTurn: 1, note: "", missEffect: "relation", attendance: "absent", history: [{ turn: 1, kind: "missed", from: clock(), to: null }] }],
    npcBonds: [{ key: "merchant", name: "Merchant", updatedTurn: 1, history: [{ turn: 1, kind: "missed", text: "Герой не пришёл", delta: -5, at: clock() }], knows: [{ text: "герой торгует", turn: 1 }] }],
    npcSchedules: [{ id: "s1", npcKey: "merchant", npcName: "Merchant", place: "Market", from: 420, to: 900, repeat: "daily", day: null, note: "", createdTurn: 1 }],
    arcHistory: [{ goal: "Trade", stakes: "", conflict: "", endCondition: "", epilogue: "Done", resolvedTurn: 1, closedTurn: 1, closedAt: clock() }],
  };
  snapshot.turns[0].stateChanges = applied({
    npcs: [{ name: "Merchant", relation: -5, delta: -5, status: "alive", isNew: false, note: "обиделся" }],
    social: { bonds: [{ name: "Merchant", kind: "missed", text: "Герой не пришёл", delta: -5 }], schedules: [], knowledge: [], missed: [{ title: "Ужин", parties: ["Merchant"], penalty: 5 }], overdue: [] },
  });
  const document = JSON.parse(JSON.stringify(createPortableDocument(snapshot)));
  const parsed = JSON.stringify(parsePortableDocument(document));
  for (const key of ["npcSchedules", "npcBonds", "arcHistory", "missEffect", "\"social\"", "обиделся"]) assert.ok(parsed.includes(key), key);
  const tampered = JSON.parse(JSON.stringify(document));
  const tamperedWorld = JSON.stringify(tampered).replace("\"npcSchedules\":", "\"npcSecrets\":[],\"npcSchedules\":");
  assert.throws(() => parsePortableDocument(JSON.parse(tamperedWorld)));
});
