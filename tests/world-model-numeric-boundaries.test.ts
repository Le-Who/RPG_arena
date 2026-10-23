import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorldState } from "../src/db/schema";
import { parseResolution } from "../src/lib/resolution";
import { readAgenda } from "../src/lib/world-agenda";
import { readSocial } from "../src/lib/world-social";
import { applyLife, emptyLifeChanges, readArcHistory, readLife } from "../src/lib/world-life";
import { readConditionTimers } from "../src/lib/conditions";

const malformed = { toString: null };
const world = (patch: Partial<WorldState> = {}): WorldState => ({ worldName: "Город", tone: "повседневность", era: "наши дни", mainQuest: "", currentLocation: "Кафе", factions: [], flags: {}, danger: 0, chapter: 1, ...patch });

// A malformed numeric field must not abort the entire generated turn or erase valid siblings.
for (const row of [
  { name: "elapsed minutes", changes: { time: { advanceMinutes: malformed } }, check: (p: ReturnType<typeof parseResolution>["payload"]) => assert.equal(p.life?.advanceMinutes, null) },
  { name: "commitment day", changes: { commitments: [{ title: "Ужин", day: malformed }] }, check: (p: ReturnType<typeof parseResolution>["payload"]) => assert.equal(p.life?.commitments[0].day, null) },
  { name: "transfer quantity", changes: { transfers: [{ ref: "11111111-aaaa-4aaa-8aaa-111111111111", to: "anna", quantity: malformed, accepted: true }] }, check: (p: ReturnType<typeof parseResolution>["payload"]) => assert.equal(p.life?.transfers[0].quantity, 1) },
  { name: "agenda delay", changes: { events: [{ title: "Ужин", inMinutes: malformed }] }, check: (p: ReturnType<typeof parseResolution>["payload"]) => assert.equal(p.agenda?.events[0].inMinutes, null) },
  { name: "agenda day", changes: { events: [{ title: "Ужин", day: malformed }] }, check: (p: ReturnType<typeof parseResolution>["payload"]) => assert.equal(p.agenda?.events[0].day, null) },
  { name: "schedule day", changes: { npcSchedule: [{ npc: "anna", place: "Кафе", from: "09:00", to: "12:00", repeat: "once", day: malformed }] }, check: (p: ReturnType<typeof parseResolution>["payload"]) => assert.equal(p.social?.schedule[0].day, null) },
]) test(`object-valued ${row.name} preserves a valid generated resource sibling`, () => {
  const parsed = parseResolution(JSON.stringify({ narration: "Ты осмотрел кафе.", effects: { gold: 3 }, stateChanges: row.changes }));
  assert.equal(parsed.parsedJson, true);
  assert.equal(parsed.payload.effects.gold, 3);
  row.check(parsed.payload);
});

test("malformed persisted agenda numeric metadata cannot abort valid sibling events", () => {
  const agenda = readAgenda(world({ agenda: [
    { id: "bad-clock", title: "Некорректное", kind: "world", npcKey: "", npcName: "", at: { day: malformed, minute: 540 }, note: "", status: "pending", createdTurn: 1 },
    { id: "good", title: "Ужин", kind: "world", npcKey: "", npcName: "", at: { day: 2, minute: 720 }, note: "", status: "pending", createdTurn: malformed },
  ] } as unknown as Partial<WorldState>));
  assert.deepEqual(agenda.events.map(e => [e.id, e.at, e.createdTurn]), [["good", { day: 2, minute: 720 }, 0]]);
});

test("malformed persisted social counters retain valid bond state with numeric defaults", () => {
  const social = readSocial(world({ npcBonds: [{ key: "anna", name: "Анна", knows: [], history: [{ turn: malformed, kind: "gift", text: "Получила книгу", delta: malformed }], updatedTurn: malformed }] } as unknown as Partial<WorldState>));
  assert.equal(social.bonds.length, 1);
  assert.equal(social.bonds[0].updatedTurn, 0);
  assert.deepEqual(social.bonds[0].history.map(h => [h.turn, h.delta]), [[0, 0]]);
});

test("malformed historical arc numbers retain bounded defaults without aborting the archive", () => {
  const archive = readArcHistory(world({ arcHistory: [{ goal: "Открыть кафе", closedAt: { day: malformed, minute: 1 }, resolvedTurn: malformed, closedTurn: malformed }] } as unknown as Partial<WorldState>));
  assert.equal(archive.length, 1);
  assert.deepEqual([archive[0].resolvedTurn, archive[0].closedTurn, archive[0].closedAt], [0, 0, { day: 1, minute: 0 }]);
});

test("malformed condition timer numbers cannot prevent reading a valid sibling", () => {
  const timers = readConditionTimers(world({ conditionTimers: {
    сломан: { expiresAt: { day: malformed, minute: 600 }, sinceTurn: 1 },
    напуган: { expiresAt: { day: 2, minute: 600 }, sinceTurn: malformed },
  } } as unknown as Partial<WorldState>));
  assert.deepEqual(timers, { напуган: { expiresAt: { day: 2, minute: 600 }, sinceTurn: 0 } });
});

// An explicitly instantaneous scene must not consume the fallback duration of its action.
test("explicit zero elapsed minutes preserves the clock while an omitted duration uses the action default", () => {
  const before = world({ clock: { day: 1, minute: 1439 } });
  const input = { world: before, inventory: [], npcs: [], locations: [], intent: "act" as const,
    defaultMinutes: 5, turnNumber: 2, touchedItemIds: new Set<string>(), mainQuestCompleted: false };
  const instantaneous = applyLife({ ...input, life: { ...emptyLifeChanges(), advanceMinutes: 0 } });
  assert.deepEqual(readLife(instantaneous.world).clock, { day: 1, minute: 1439 });
  assert.equal(instantaneous.applied.clock, null);
  assert.deepEqual(instantaneous.events, []);
  const fallback = applyLife({ ...input, life: emptyLifeChanges() });
  assert.deepEqual(readLife(fallback.world).clock, { day: 2, minute: 4 });
  assert.equal(fallback.applied.clock?.minutes, 5);
  assert.deepEqual(before.clock, { day: 1, minute: 1439 });
});
