import { test } from "node:test";
import assert from "node:assert/strict";
import { gateConditionRemovals, type RemovalEvidence } from "../src/lib/conditions";
import { continueStory, readLife } from "../src/lib/world-life";
import { applySocial, emptySocialChanges, parseSocialChanges, readSocial } from "../src/lib/world-social";
import type { AppliedChanges, WorldState } from "../src/db/schema";

const world = (): WorldState => ({ worldName: "Город", tone: "быт", era: "сейчас", mainQuest: "Старая цель", currentLocation: "Дом", factions: [], flags: {}, danger: 0, chapter: 1, clock: { day: 2, minute: 600 } });
const npc = { id: "11111111-1111-4111-8111-111111111111", key: "anna", name: "Анна", role: "пекарь", relation: 10, status: "alive" as const, description: "", lastLocation: "Дом" };
const applied = (): AppliedChanges => ({ hp: 0, xp: 0, gold: 0, danger: 0, levelUp: false, dead: false, location: null, quests: [], npcs: [], inventory: [], sceneObjects: [], conditions: { added: [], removed: [] }, rejected: [] });
const run = (patch: Partial<Parameters<typeof applySocial>[0]> = {}) => applySocial({ world: world(), startClock: { day: 2, minute: 480 }, startLocation: "Дом", npcs: [npc], locations: [], applied: applied(), changes: emptySocialChanges(), intent: "act", turnNumber: 8, narration: "Анна работает дома с девяти до полудня.", ...patch });
const ev = (patch: Partial<RemovalEvidence> = {}): RemovalEvidence => ({ intent: "act", minutes: 10, consumed: [], goldSpent: 0, narration: "", dice: null, ...patch });

test("long travel and mere mention of a doctor are not rest or treatment", () => {
  assert.deepEqual(gateConditionRemovals(["устал", "ранен"], ev({ minutes: 1440, narration: "Ты весь день шёл по дороге мимо больницы." })).restored, ["устал", "ранен"]);
  assert.deepEqual(gateConditionRemovals(["ранен"], ev({ minutes: 40, goldSpent: 5, narration: "Врач отказался лечить тебя. Ты заплатил за проезд." })).restored, ["ранен"]);
});

test("another person's meal and discarded medicine cannot cure the hero", () => {
  assert.deepEqual(gateConditionRemovals(["голоден"], ev({ goldSpent: 5, narration: "Анна пообедала, а ты остался голоден." })).restored, ["голоден"]);
  assert.deepEqual(gateConditionRemovals(["отравлен"], ev({ consumed: [{ name: "Бинты" }], narration: "Ты выбросил бинты." })).restored, ["отравлен"]);
});

test("treating or observing another person cannot cure the hero", () => {
  assert.deepEqual(gateConditionRemovals(["ранен"], ev({ action: "Перевязываю стражника", narration: "Ты перевязал раненого стражника.", consumed: [{ name: "Бинты" }] })).restored, ["ранен"]);
  assert.deepEqual(gateConditionRemovals(["ранен"], ev({ action: "Лечу себя", minutes: 40, narration: "Ты наблюдаешь, как врач перевязал стражника." })).restored, ["ранен"]);
  assert.deepEqual(gateConditionRemovals(["голоден"], ev({ action: "Заказываю обед", goldSpent: 5, narration: "Ты смотрел, как Анна пообедала." })).restored, ["голоден"]);
});

test("schedule proposals fail closed without final evidence and for intentions", () => {
  const changes = parseSocialChanges({ npcSchedule: [{ npc: "anna", place: "Дом", from: "09:00", to: "12:00", evidence: "Анна работает дома с девяти до полудня." }] });
  assert.equal(readSocial(run({ changes, narration: undefined }).world).schedules.length, 0);
  assert.equal(readSocial(run({ changes, intent: "intend" }).world).schedules.length, 0);
});

test("elapsed one-off slots and overlapping places do not create contradictory presence", () => {
  const changes = parseSocialChanges({ npcSchedule: [{ npc: "anna", place: "Дом", from: "07:00", to: "08:00", repeat: "once", day: 2, evidence: "Анна работает дома с девяти до полудня." }] });
  assert.equal(readSocial(run({ changes }).world).schedules.length, 0);
  const before = world();
  before.npcSchedules = [{ id: "s1", npcKey: "anna", npcName: "Анна", place: "Дом", from: 540, to: 720, repeat: "daily", day: null, note: "", createdTurn: 1 }];
  const overlap = parseSocialChanges({ npcSchedule: [{ npc: "anna", place: "Порт", from: "10:00", to: "13:00", evidence: "Анна работает дома с девяти до полудня." }] });
  assert.equal(readSocial(run({ world: before, changes: overlap }).world).schedules.length, 1);
});

test("split daily schedules preserve both windows at the same place", () => {
  const changes = parseSocialChanges({ npcSchedule: [
    { npc: "anna", place: "Дом", from: "07:00", to: "11:00", evidence: "Анна работает дома с девяти до полудня." },
    { npc: "anna", place: "Дом", from: "13:00", to: "18:00", evidence: "Анна работает дома с девяти до полудня." },
  ] });
  assert.equal(readSocial(run({ changes }).world).schedules.length, 2);
});

test("endpoints do not prove a missed appointment or authorize a relation penalty", () => {
  const before = world();
  before.commitments = [{ id: "c1", title: "Встреча", parties: ["Анна"], place: "Кафе", due: { day: 2, minute: 500 }, status: "accepted", createdTurn: 1, updatedTurn: 1, note: "", missEffect: "relation" }];
  const original = structuredClone(before);
  const result = run({ world: before });
  assert.equal(readLife(result.world).commitments[0].status, "accepted");
  assert.deepEqual(result.ops, []);
  assert.deepEqual(before, original, "reducers must not mutate their input");
  assert.equal(npc.relation, 10);
});

test("continuation requires a complete arc, updates the active goal and copies its archive clock", () => {
  const before = world();
  before.story = { kind: "arc", goal: "Старая цель", stakes: "дом", conflict: "долг", endCondition: "долг погашен", focus: [], status: "resolved" };
  assert.equal(continueStory(before, { continueAs: "arc", goal: "Новая цель" }, 8).ok, false);
  const next = continueStory(before, { continueAs: "arc", goal: "Новая цель", stakes: "семья", conflict: "переезд", endCondition: "новоселье" }, 8);
  assert.ok(next.ok);
  assert.equal(next.world.mainQuest, "Новая цель");
  const open = continueStory(before, { continueAs: "open-life" }, 8);
  assert.ok(open.ok);
  assert.equal(open.world.mainQuest, "");
  assert.notEqual(open.world.arcHistory![0].closedAt, open.world.clock);
});
