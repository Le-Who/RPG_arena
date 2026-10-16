import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AppliedChanges, WorldState } from "../src/db/schema";
import type { AIConfig } from "../src/lib/ai-settings";
import { applySocial, editSocial, minutesUntilSlot, npcPresence, readSocial, schedulesOverlap, slotActive, type ScheduleSlot } from "../src/lib/world-social";
import { applyAgenda, parseAgendaChanges, readAgenda } from "../src/lib/world-agenda";
import { emptyChanges, parseResolution } from "../src/lib/resolution";
import { accountsDb } from "./helpers/accounts-db";

const world = (patch: Partial<WorldState> = {}): WorldState => ({
  worldName: "Гавань", tone: "повседневность", era: "наши дни", mainQuest: "", currentLocation: "Причал",
  factions: [], flags: {}, danger: 0, chapter: 1, clock: { day: 1, minute: 540 }, ...patch,
});
const anna = { id: "anna-id", key: "anna", name: "Анна", role: "смотритель", relation: 0, status: "alive" as const, description: "", lastLocation: "Причал" };
const locs = [{ id: "pier", name: "Причал", x: 0, y: 0, current: true, discovered: true, danger: 0, connectedTo: [] }];
const applied = (): AppliedChanges => ({ hp: 0, xp: 0, gold: 0, danger: 0, levelUp: false, dead: false, location: null, quests: [], npcs: [], inventory: [], sceneObjects: [], conditions: { added: [], removed: [] }, rejected: [] });
const slot = (patch: Partial<ScheduleSlot> = {}): ScheduleSlot => ({ id: "night", npcKey: "anna", npcName: "Старое имя", place: "Причал", from: 1320, to: 120, repeat: "daily", day: null, note: "", createdTurn: 1, ...patch });

// Catches inclusive end boundaries, lost midnight continuation, and waits that restart expired once slots.
const timeCases = [
  { label: "daily day1 midnight", repeat: "daily", day: null, clock: { day: 1, minute: 0 }, active: true, wait: 0 },
  { label: "daily before overnight end", repeat: "daily", day: null, clock: { day: 3, minute: 119 }, active: true, wait: 0 },
  { label: "daily exact overnight end", repeat: "daily", day: null, clock: { day: 3, minute: 120 }, active: false, wait: 1200 },
  { label: "daily before start", repeat: "daily", day: null, clock: { day: 3, minute: 1319 }, active: false, wait: 1 },
  { label: "daily exact start", repeat: "daily", day: null, clock: { day: 3, minute: 1320 }, active: true, wait: 0 },
  { label: "daily last minute", repeat: "daily", day: null, clock: { day: 3, minute: 1439 }, active: true, wait: 0 },
  { label: "once previous day", repeat: "once", day: 2, clock: { day: 1, minute: 1439 }, active: false, wait: 1321 },
  { label: "once start-day early morning", repeat: "once", day: 2, clock: { day: 2, minute: 60 }, active: false, wait: 1260 },
  { label: "once before start", repeat: "once", day: 2, clock: { day: 2, minute: 1319 }, active: false, wait: 1 },
  { label: "once exact start", repeat: "once", day: 2, clock: { day: 2, minute: 1320 }, active: true, wait: 0 },
  { label: "once next midnight", repeat: "once", day: 2, clock: { day: 3, minute: 0 }, active: true, wait: 0 },
  { label: "once last active minute", repeat: "once", day: 2, clock: { day: 3, minute: 119 }, active: true, wait: 0 },
  { label: "once exact end", repeat: "once", day: 2, clock: { day: 3, minute: 120 }, active: false, wait: null },
  { label: "once following day", repeat: "once", day: 2, clock: { day: 4, minute: 60 }, active: false, wait: null },
  { label: "once missing day", repeat: "once", day: null, clock: { day: 2, minute: 1320 }, active: false, wait: null },
] as const;
for (const row of timeCases) test(`overnight activity and wait: ${row.label}`, () => {
  const input = { slot: slot({ repeat: row.repeat, day: row.day }), clock: { ...row.clock } };
  const before = structuredClone(input);
  assert.equal(slotActive(input.slot, input.clock), row.active);
  assert.equal(minutesUntilSlot(input.slot, input.clock), row.wait);
  assert.deepEqual(input, before);
});

// Catches asymmetric recurring/once comparisons and intersections mistaken for touching endpoints.
const overlapCases = [
  { label: "daily crossing midnight", a: slot(), b: slot({ from: 60, to: 180 }), want: true },
  { label: "daily touching overnight end", a: slot(), b: slot({ from: 120, to: 180 }), want: false },
  { label: "daily touching overnight start", a: slot(), b: slot({ from: 1200, to: 1320 }), want: false },
  { label: "daily one-minute intersection", a: slot(), b: slot({ from: 119, to: 180 }), want: true },
  { label: "once following-day intersection", a: slot({ repeat: "once", day: 2 }), b: slot({ repeat: "once", day: 3, from: 60, to: 180 }), want: true },
  { label: "once following-day touching", a: slot({ repeat: "once", day: 2 }), b: slot({ repeat: "once", day: 3, from: 120, to: 180 }), want: false },
  { label: "once same-day morning disjoint", a: slot({ repeat: "once", day: 2 }), b: slot({ repeat: "once", day: 2, from: 60, to: 180 }), want: false },
  { label: "once two days apart", a: slot({ repeat: "once", day: 2 }), b: slot({ repeat: "once", day: 4, from: 60, to: 180 }), want: false },
  { label: "daily versus late once morning", a: slot(), b: slot({ repeat: "once", day: 800, from: 60, to: 180 }), want: true },
  { label: "daily versus once day1 morning", a: slot(), b: slot({ repeat: "once", day: 1, from: 30, to: 90 }), want: true },
  { label: "once day1 morning touching recurring end", a: slot(), b: slot({ repeat: "once", day: 1, from: 120, to: 180 }), want: false },
  { label: "once overnight versus daily morning", a: slot({ repeat: "once", day: 1 }), b: slot({ from: 0, to: 30 }), want: true },
] as const;
for (const row of overlapCases) test(`schedule overlap is symmetric: ${row.label}`, () => {
  const before = structuredClone([row.a, row.b]);
  assert.equal(schedulesOverlap(row.a, row.b), row.want, "forward");
  assert.equal(schedulesOverlap(row.b, row.a), row.want, "reverse");
  assert.deepEqual([row.a, row.b], before);
});

test("scene and owner admission reject a once day1 window during the active daily overnight continuation", () => {
  const inputWorld = world({ clock: { day: 1, minute: 30 }, npcSchedules: [slot()] });
  const before = structuredClone(inputWorld);
  const narration = "Анна дежурит у причала с половины первого до половины второго.";
  const result = applySocial({ world: inputWorld, startClock: { day: 1, minute: 30 }, startLocation: "Причал", npcs: [anna], locations: locs, applied: applied(), intent: "act", turnNumber: 2,
    narration, changes: { knowledge: [], schedule: [{ npc: "anna", place: "Причал", from: "00:30", to: "01:30", repeat: "once", day: 1, note: "", remove: false, evidence: narration }] } });
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0], /пересекаются/);
  assert.deepEqual(result.applied.schedules, []);
  assert.deepEqual(readSocial(result.world).schedules, [slot()]);
  assert.deepEqual(result.events, []);
  const owner = editSocial({ world: inputWorld, npcs: [anna], locations: locs, turn: 2,
    edit: { op: "schedule.upsert", npcKey: "anna", place: "Причал", from: "00:30", to: "01:30", repeat: "once", day: 1 } });
  assert.equal(owner.ok, false);
  if (!owner.ok) assert.match(owner.error, /пересекаются/);
  assert.deepEqual(inputWorld, before);
});

test("scene and owner admission allow a once day1 window touching the daily overnight end", () => {
  const inputWorld = world({ clock: { day: 1, minute: 30 }, npcSchedules: [slot()] });
  const before = structuredClone(inputWorld);
  const narration = "Анна дежурит у причала с двух до трёх утра.";
  const result = applySocial({ world: inputWorld, startClock: { day: 1, minute: 30 }, startLocation: "Причал", npcs: [anna], locations: locs, applied: applied(), intent: "act", turnNumber: 2,
    narration, makeId: () => "touching", changes: { knowledge: [], schedule: [{ npc: "anna", place: "Причал", from: "02:00", to: "03:00", repeat: "once", day: 1, note: "", remove: false, evidence: narration }] } });
  assert.deepEqual(result.rejected, []);
  assert.equal(result.applied.schedules.length, 1);
  assert.deepEqual(readSocial(result.world).schedules.map(s => [s.from, s.to, s.repeat, s.day]), [[1320, 120, "daily", null], [120, 180, "once", 1]]);
  const owner = editSocial({ world: inputWorld, npcs: [anna], locations: locs, turn: 2,
    edit: { op: "schedule.upsert", npcKey: "anna", place: "Причал", from: "02:00", to: "03:00", repeat: "once", day: 1 } });
  assert.ok(owner.ok);
  assert.deepEqual(readSocial(owner.world).schedules.map(s => [s.from, s.to, s.repeat, s.day]), [[1320, 120, "daily", null], [120, 180, "once", 1]]);
  assert.deepEqual(inputWorld, before);
});

const presenceCases = [
  { label: "daily day1 continuation here", schedule: slot(), clock: { day: 1, minute: 30 }, place: "Причал", status: "alive", want: { here: ["anna"], away: [], later: [] }, hint: "до 02:00" },
  { label: "daily continuation away", schedule: slot(), clock: { day: 3, minute: 30 }, place: "Дом", status: "alive", want: { here: [], away: ["anna"], later: [] }, hint: "до 02:00" },
  { label: "daily end then later today", schedule: slot(), clock: { day: 3, minute: 120 }, place: "Причал", status: "alive", want: { here: [], away: [], later: ["anna"] }, hint: "с 22:00" },
  { label: "once before starting day", schedule: slot({ repeat: "once", day: 4 }), clock: { day: 2, minute: 120 }, place: "Причал", status: "alive", want: { here: [], away: [], later: ["anna"] }, hint: "день 4, с 22:00" },
  { label: "once tomorrow", schedule: slot({ repeat: "once", day: 4 }), clock: { day: 3, minute: 1439 }, place: "Причал", status: "alive", want: { here: [], away: [], later: ["anna"] }, hint: "завтра с 22:00" },
  { label: "once continuation", schedule: slot({ repeat: "once", day: 4 }), clock: { day: 5, minute: 119 }, place: "Причал", status: "alive", want: { here: ["anna"], away: [], later: [] }, hint: "до 02:00" },
  { label: "once expired", schedule: slot({ repeat: "once", day: 4 }), clock: { day: 5, minute: 120 }, place: "Причал", status: "alive", want: { here: [], away: [], later: [] } },
  { label: "dead", schedule: slot(), clock: { day: 3, minute: 30 }, place: "Причал", status: "dead", want: { here: [], away: [], later: [] } },
  { label: "missing", schedule: slot(), clock: { day: 3, minute: 30 }, place: "Причал", status: "missing", want: { here: [], away: [], later: [] } },
] as const;
for (const row of presenceCases) test(`presence uses current location, identity, status and explicit clock: ${row.label}`, () => {
  const input = { world: world({ clock: { day: 99, minute: 600 }, currentLocation: row.place, npcSchedules: [row.schedule, slot({ id: "unknown", npcKey: "unknown" })] }), npcs: [{ ...anna, status: row.status }], clock: { ...row.clock } };
  const before = structuredClone(input);
  const presence = npcPresence(input.world, input.npcs, input.clock);
  assert.deepEqual({ here: presence.here.map(x => x.npcKey), away: presence.away.map(x => x.npcKey), later: presence.later.map(x => x.npcKey) }, row.want);
  const entry = [...presence.here, ...presence.away, ...presence.later][0];
  if ("hint" in row) { assert.equal(entry.hint, row.hint); assert.equal(entry.name, "Анна"); }
  assert.deepEqual(input, before);
});

test("presence defaults to persisted clock and chooses the earliest future window regardless of storage order", () => {
  const inputWorld = world({ clock: { day: 2, minute: 180 }, npcSchedules: [slot({ id: "late", place: "Кафе", from: 900, to: 960 }), slot({ id: "early", from: 240, to: 300 })] });
  const before = structuredClone(inputWorld);
  assert.deepEqual(npcPresence(inputWorld, [anna]), {
    here: [], away: [], later: [{ npcKey: "anna", name: "Анна", place: "Причал", window: "04:00–05:00, ежедневно", hint: "с 04:00" }],
  });
  assert.deepEqual(inputWorld, before);
});

// Exact provenance must reject absent/short evidence while retaining valid pronoun contexts.
for (const row of [
  { label: "absent quote", quote: "Она рассказала совсем другое.", want: 0 },
  { label: "short quote", quote: "Анна", want: 0 },
  { label: "valid pronoun context", quote: "Она знает, что герой ищет брата.", want: 1 },
]) test(`social and agenda provenance admission: ${row.label}`, () => {
  const narration = "Анна подошла. Она знает, что герой ищет брата. Она дежурит с девяти до трёх. Она хочет открыть кафе.";
  const payload = parseResolution(JSON.stringify({ narration, outcome: "neutral", effects: { hp: 0, xp: 0, gold: 0, danger: 0 }, choices: ["Продолжить"], stateChanges: {
    ...emptyChanges(), npcKnowledge: [{ npc: "anna", fact: "герой ищет брата", evidence: row.quote }],
    npcSchedule: [{ npc: "anna", place: "Причал", from: "09:00", to: "15:00", evidence: row.want ? "Она дежурит с девяти до трёх." : row.quote }],
    npcGoals: [{ npc: "anna", goal: "открыть кафе", evidence: row.want ? "Она хочет открыть кафе." : row.quote }],
  } })).payload;
  const inputWorld = world();
  const before = structuredClone({ inputWorld, payload, npcs: [anna], locations: locs });
  const social = applySocial({ world: inputWorld, startClock: { day: 1, minute: 540 }, startLocation: "Причал", npcs: [anna], locations: locs, applied: applied(), intent: "act", turnNumber: 2, narration, changes: payload.social! });
  const agenda = applyAgenda({ world: inputWorld, npcs: [anna], intent: "act", turnNumber: 2, narration, changes: payload.agenda! });
  assert.equal(social.applied.knowledge.length, row.want);
  assert.equal(social.applied.schedules.length, row.want);
  assert.equal(agenda.applied.npcGoals.length, row.want);
  assert.equal(social.events.length, row.want * 2);
  assert.equal(agenda.events.length, row.want);
  assert.equal(social.rejected.length, row.want ? 0 : 2);
  assert.equal(agenda.rejected.length, row.want ? 0 : 1);
  assert.deepEqual({ inputWorld, payload, npcs: [anna], locations: locs }, before);
});

test("agenda completion needs final narration provenance and changes only the due event", () => {
  const inputWorld = world({ clock: { day: 2, minute: 600 }, agenda: [{ id: "visit", title: "Визит Анны", kind: "npc", npcKey: "anna", npcName: "Анна", at: { day: 2, minute: 600 }, note: "", status: "pending", createdTurn: 1 }] });
  const before = structuredClone(inputWorld);
  for (const row of [{ quote: "Анна пришла к причалу.", status: "fired", count: 1 }, { quote: "Анна ушла с причала.", status: "due", count: 0 }] as const) {
    const changes = parseAgendaChanges({ events: [{ ref: "visit", complete: true, evidence: row.quote }] });
    const result = applyAgenda({ world: inputWorld, npcs: [anna], intent: "act", turnNumber: 2, narration: "Анна пришла к причалу.", changes });
    assert.equal(readAgenda(result.world).events[0].status, row.status);
    assert.equal(result.applied.fired.length, row.count);
    assert.equal(result.events.length, row.count);
    assert.deepEqual(inputWorld, before);
  }
});

test("configured verifier verdict reaches persisted social and agenda admission for another NPC, tomorrow and valid current facts", async t => {
  const f = await accountsDb();
  const { performTurn } = await import("../src/lib/turn");
  const cfg: AIConfig = {
    keys: ["synthetic-social-key"], dbKeyCount: 1, envKeyCount: 0, useLiveAI: true, canUseLive: true,
    routingConfig: { profile: "balanced", narrationModel: "gemini-3.5-flash-lite", customActionModel: "gemini-3.8-flash", compactionModel: "gemini-3.8-flash", fastTaskModel: "gemini-3.5-flash-lite" }, limits: { flash: 20, lite: 500 }, enforceLimits: false,
    embeddingsEnabled: false, embeddingModel: "gemini-embedding-2", embeddingDims: 768, semanticExtractionEnabled: true,
  };
  const character = { name: "Искатель", archetype: "Путник", level: 1, xp: 0, hp: 20, maxHp: 20, gold: 5, stats: {}, skills: [], traits: [], conditions: [], backstory: "", appearance: "" };
  try {
    for (const row of [
      { label: "another NPC", quote: "Олег знает, что герой ищет брата.", verdict: "rejected" },
      { label: "tomorrow is not a current fact", quote: "Завтра Анна узнает, что герой ищет брата.", verdict: "rejected" },
      { label: "valid current pronoun context", quote: "Она знает, что герой ищет брата.", verdict: "verified" },
    ] as const) await t.test(row.label, async () => {
      const id = randomUUID(), requestId = randomUUID();
      await f.pg.query("INSERT INTO game_sessions(id,title,campaign_mode,rules_profile,character,world_state,turn_count,owner_id) VALUES ($1,'Social boundary','free','narrative',$2,$3,1,'social-boundary-owner')", [id, JSON.stringify(character), JSON.stringify(world())]);
      await f.pg.query("INSERT INTO npcs(session_id,key,name,status,last_location) VALUES ($1,'anna','Анна','alive','Причал'),($1,'oleg','Олег','alive','Причал')", [id]);
      const valid = row.verdict === "verified";
      const scheduleQuote = valid ? "Она дежурит с девяти до трёх." : row.quote;
      const goalQuote = valid ? "Она хочет открыть кафе." : row.quote;
      const narration = valid ? `Анна подошла. ${row.quote} ${scheduleQuote} ${goalQuote}` : row.quote;
      const draft = { continuity: { mode: "event", referencesPast: false }, outcome: "neutral", effects: { hp: 0, xp: 0, gold: 0, danger: 0 }, stateChanges: {
        ...emptyChanges(), time: { advanceMinutes: 5 }, npcKnowledge: [{ npc: "anna", fact: "герой ищет брата", evidence: row.quote }],
        npcSchedule: [{ npc: "anna", place: "Причал", from: "09:00", to: "15:00", evidence: scheduleQuote }],
        npcGoals: [{ npc: "anna", goal: "открыть кафе", evidence: goalQuote }],
      }, choices: ["Продолжить разговор"], narration };
      const before = (await f.pg.query("SELECT character,world_state,turn_count FROM game_sessions WHERE id=$1", [id])).rows;
      const checked: Record<string, unknown>[] = [];
      let generations = 0;
      const transport = mock.method(globalThis, "fetch", async (url: unknown) => {
        assert.match(String(url), /^https:\/\/generativelanguage\.googleapis\.com\//);
        const response = ++generations === 1 ? draft : { narration, choices: draft.choices };
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(response) }] }, finishReason: "STOP" }] });
      });
      try {
        const result = await performTurn({ sessionId: id, requestId, expectedTurn: 1, isFree: true, action: "Поговорить с Анной" }, {
          loadAIConfig: async () => cfg, loadNarrativeConfig: async () => ({ enabled: true, provider: "openrouter", apiKey: "synthetic-verifier-key" }), schedule() {}, scheduleDiagnostics() {},
          verifyNarrative: async input => {
            checked.push(structuredClone(input.state));
            assert.equal(input.state.draft, narration);
            const changes = input.state.accepted_changes as { social: { knowledge: unknown[]; schedules: unknown[] }; agenda: { npcGoals: unknown[] } };
            // These literal quotes pass provenance. The authored verdict, not a claimed NLP rule, supplies semantic refusal.
            assert.deepEqual(changes.social.knowledge, [{ name: "Анна", fact: "герой ищет брата" }]);
            assert.equal(changes.social.schedules.length, 1);
            assert.deepEqual(changes.agenda.npcGoals, [{ name: "Анна", goal: "открыть кафе", routine: "" }]);
            return { status: row.verdict, provider: "openrouter", model: "typesafe/jev-1.13", answers: {}, latencyMs: 1 };
          },
        });
        assert.equal(result.ok, valid, JSON.stringify(result));
        assert.equal(checked.length, valid ? 1 : 2);
        const turns = (await f.pg.query<{ content: string; state_changes: AppliedChanges }>("SELECT content,state_changes FROM game_turns WHERE session_id=$1 AND role='narrator'", [id])).rows;
        const memories = (await f.pg.query<{ entity_key: string; content: string }>("SELECT entity_key,content FROM memory_nodes WHERE session_id=$1 ORDER BY entity_key", [id])).rows;
        const jobs = (await f.pg.query<{ payload: { narration: string } }>("SELECT payload FROM memory_jobs WHERE session_id=$1", [id])).rows;
        const persisted = (await f.pg.query<{ world_state: WorldState; turn_count: number }>("SELECT character,world_state,turn_count FROM game_sessions WHERE id=$1", [id])).rows;
        if (!valid) {
          assert.deepEqual(persisted, before);
          assert.deepEqual(turns, []);
          assert.deepEqual(memories, []);
          assert.deepEqual(jobs, []);
          assert.equal((await f.pg.query("SELECT id FROM game_turns WHERE session_id=$1", [id])).rows.length, 0);
          assert.equal(result.ok ? null : result.code, "AI_FAILED");
        } else {
          assert.equal(persisted[0].turn_count, 2);
          assert.deepEqual(readSocial(persisted[0].world_state).bonds[0].knows, [{ text: "герой ищет брата", turn: 2 }]);
          assert.deepEqual(readSocial(persisted[0].world_state).schedules.map(s => [s.npcKey, s.place, s.from, s.to, s.repeat, s.day]), [["anna", "Причал", 540, 900, "daily", null]]);
          assert.deepEqual(readAgenda(persisted[0].world_state).npcAgendas, [{ key: "anna", name: "Анна", goal: "открыть кафе", routine: "", updatedTurn: 2 }]);
          assert.equal(turns[0].content, narration);
          assert.deepEqual(turns[0].state_changes.social?.knowledge, [{ name: "Анна", fact: "герой ищет брата" }]);
          assert.deepEqual(turns[0].state_changes.agenda?.npcGoals, [{ name: "Анна", goal: "открыть кафе", routine: "" }]);
          assert.deepEqual(memories.map(m => m.entity_key), ["npc:anna:goal", "npc:anna:knows:герой ищет брата", "npc:anna:schedule"]);
          assert.deepEqual(jobs.map(j => j.payload.narration), [narration]);
        }
      } finally { transport.mock.restore(); }
    });
  } finally { await f.close(); }
});
