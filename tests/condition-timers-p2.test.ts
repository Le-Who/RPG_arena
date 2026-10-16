import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { CharacterState, WorldState } from "../src/db/schema";
import { applyConditionTimers, conditionExpiry, gateConditionRemovals, readConditionTimers, type RemovalEvidence } from "../src/lib/conditions";
import { portableFixture, now } from "./helpers/portable-fixture";
import { createPortableDocument, parsePortableDocument } from "../src/lib/campaign-portable";
import { accountsDb } from "./helpers/accounts-db";
import { applyResolution, parseResolution, type ApplyInput } from "../src/lib/resolution";

const hero = (conditions: string[] = []): CharacterState => ({ name: "Мира", archetype: "Курьер", level: 1, xp: 0, hp: 10, maxHp: 10, gold: 0, stats: {}, skills: [], traits: [], backstory: "", appearance: "", conditions });
const world = (): WorldState => ({ worldName: "Город", tone: "Повседневность", era: "Сегодня", mainQuest: "", currentLocation: "Кафе", factions: [], flags: {}, danger: 0, chapter: 1, clock: { day: 3, minute: 1380 } });
const evidence = (patch: Partial<RemovalEvidence> = {}): RemovalEvidence => ({ intent: "act", action: "Перевязываю свою рану", heroName: "Мира", narration: "Ты перевязал свою рану.", minutes: 5, consumed: [{ name: "Бинты", kind: "consumable" }], goldSpent: 0, dice: null, ...patch });

// Catches ignoring a known nonmedicine kind while retaining legacy evidence without kind.
for (const [kind, restored] of [["consumable", []], ["document", ["ранен"]], ["tool", ["ранен"]], [undefined, []]] as const) {
  test(`medicine evidence respects the consumed item kind: ${kind ?? "legacy"}`, () => {
    const input = evidence({ consumed: [{ name: "Бинты", kind }] });
    const before = structuredClone(input);
    assert.deepEqual(gateConditionRemovals(["ранен"], input).restored, restored);
    assert.deepEqual(input, before);
  });
}

// Catches treating a hero mention as proof that the hero is the patient of a reflexive verb.
for (const [narration, restored] of [
  ["Ты наблюдал, как врач перевязал свою рану.", ["ранен"]],
  ["Врач вылечил себя рядом с тобой, и ты поблагодарил его.", ["ранен"]],
  ["Ты перевязал свою рану.", []],
  ["Мира перевязала свою рану.", []],
  ["Врач перевязал твою рану.", []],
] as const) {
  test(`treatment must name the hero as patient: ${narration}`, () => {
    const input = evidence({ narration });
    const before = structuredClone(input);
    assert.deepEqual(gateConditionRemovals(["ранен"], input).restored, restored);
    assert.deepEqual(input, before);
  });
}

test("refresh replaces the original expiry across midnight and expires exactly once at its new boundary", () => {
  const input = { world: { ...world(), conditionTimers: { напуган: { expiresAt: { day: 4, minute: 0 }, sinceTurn: 2 }, orphan: { expiresAt: { day: 6, minute: 0 }, sinceTurn: 1 } } }, character: hero(["Напуган", "под подозрением"]), clock: { day: 3, minute: 1430 }, added: ["НАПУГАН"], turnNumber: 5 };
  const before = structuredClone(input);
  const refreshed = applyConditionTimers(input);
  assert.deepEqual(refreshed.scheduled, [{ condition: "НАПУГАН", expiresAt: { day: 4, minute: 110 } }]);
  assert.deepEqual(readConditionTimers(refreshed.world), { напуган: { expiresAt: { day: 4, minute: 110 }, sinceTurn: 5 } });
  assert.deepEqual(refreshed.expired, []);
  assert.deepEqual(refreshed.events, []);
  assert.deepEqual(input, before);
  for (const minute of [0, 109]) {
    const earlyInput = { world: refreshed.world, character: refreshed.character, clock: { day: 4, minute }, added: [], turnNumber: 6 };
    const earlyBefore = structuredClone(earlyInput);
    const early = applyConditionTimers(earlyInput);
    assert.deepEqual(early.character.conditions, ["Напуган", "под подозрением"]);
    assert.deepEqual(early.expired, []);
    assert.deepEqual(early.events, []);
    assert.deepEqual(earlyInput, earlyBefore);
  }
  const expiryInput = { world: refreshed.world, character: refreshed.character, clock: { day: 4, minute: 110 }, added: [], turnNumber: 7 };
  const expiryBefore = structuredClone(expiryInput);
  const expired = applyConditionTimers(expiryInput);
  assert.deepEqual(expired.character.conditions, ["под подозрением"]);
  assert.deepEqual(expired.expired, ["Напуган"]);
  assert.equal(conditionExpiry(expired.world, "Напуган"), null);
  assert.deepEqual(readConditionTimers(expired.world), {});
  assert.deepEqual(expired.events.map(e => [e.entityKey, e.content]), [
    ["character:conditions:expired:7", "К День 4, 01:50 (ночь) у Мира прошло: Напуган (ход 7)."],
    ["character:conditions", "Текущие состояния Мира: под подозрением (обновлено на ходу 7)."],
  ]);
  assert.deepEqual(expiryInput, expiryBefore);
  const again = applyConditionTimers({ world: expired.world, character: expired.character, clock: { day: 4, minute: 111 }, added: [], turnNumber: 8 });
  assert.deepEqual(again.expired, []);
  assert.deepEqual(again.events, []);
});

test("timer parsing bounds legacy numeric values and rejects malformed entries without changing its snapshot", () => {
  const input = { ...world(), conditionTimers: {
    legacy: { expiresAt: { day: "4.8", minute: "70.9" } },
    huge: { expiresAt: { day: 1e100, minute: 1e100 }, sinceTurn: 1e100 },
    negative: { expiresAt: { day: -5, minute: -10 }, sinceTurn: -8.5 },
    infinite: { expiresAt: { day: Infinity, minute: 50 }, sinceTurn: 1 },
    badTurn: { expiresAt: { day: 4, minute: 50 }, sinceTurn: Infinity },
    missingClock: {}, array: [], invalidMinute: { expiresAt: { day: 4, minute: "bad" } },
  } } as unknown as WorldState;
  const before = structuredClone(input);
  assert.deepEqual(readConditionTimers(input), {
    legacy: { expiresAt: { day: 4, minute: 70 }, sinceTurn: 0 },
    huge: { expiresAt: { day: 1_000_000, minute: 1439 }, sinceTurn: 1_000_000_000 },
    negative: { expiresAt: { day: 1, minute: 0 }, sinceTurn: 0 },
    badTurn: { expiresAt: { day: 4, minute: 50 }, sinceTurn: 0 },
  });
  assert.deepEqual(input, before);
  const snapshot = portableFixture();
  snapshot.session.worldState.conditionTimers = readConditionTimers(input);
  assert.deepEqual(parsePortableDocument(createPortableDocument(snapshot, now)).snapshot.session.worldState.conditionTimers, {
    legacy: { expiresAt: { day: 4, minute: 70 }, sinceTurn: 0 },
    huge: { expiresAt: { day: 1_000_000, minute: 1439 }, sinceTurn: 1_000_000_000 },
    negative: { expiresAt: { day: 1, minute: 0 }, sinceTurn: 0 },
    badTurn: { expiresAt: { day: 4, minute: 50 }, sinceTurn: 0 },
  });
});

test("huge timer maps admit at most 100 valid bounded entries and cannot pollute the result prototype", () => {
  const raw = Object.fromEntries([["__proto__", { expiresAt: { day: 4, minute: 70 }, sinceTurn: 1 }], ["x".repeat(101), { expiresAt: { day: 4, minute: 70 }, sinceTurn: 1 }], ["broken", null], ...Array.from({ length: 1200 }, (_, i) => [`timer-${i}`, { expiresAt: { day: 4, minute: 70 }, sinceTurn: 1 }])]);
  const input = { ...world(), conditionTimers: raw } as unknown as WorldState;
  const before = structuredClone(input);
  const timers = readConditionTimers(input);
  assert.equal(Object.keys(timers).length, 100);
  assert.deepEqual(timers["timer-0"], { expiresAt: { day: 4, minute: 70 }, sinceTurn: 1 });
  assert.deepEqual(timers["timer-99"], { expiresAt: { day: 4, minute: 70 }, sinceTurn: 1 });
  assert.equal(Object.hasOwn(timers, "timer-100"), false);
  assert.equal(Object.hasOwn(timers, "x".repeat(101)), false);
  assert.equal(Object.hasOwn(Object.getPrototypeOf(timers), "expiresAt"), false);
  assert.deepEqual(input, before);
  const snapshot = portableFixture();
  snapshot.session.worldState.conditionTimers = timers;
  assert.deepEqual(parsePortableDocument(createPortableDocument(snapshot, now)).snapshot.session.worldState.conditionTimers, timers);
});

test("resolved consume evidence retains identity, excludes failed/removal operations, and leaves reducer input unchanged", () => {
  const input: ApplyInput = { character: hero(["отравлен"]), world: world(), campaignMode: "free", rulesProfile: "narrative", inventory: [
    { id: "retained", name: "Противоядие", kind: "tool", quantity: 1, equipped: false, description: "", icon: "", power: 0 },
    { id: "medicine", name: "Противоядие", kind: "consumable", quantity: 2, equipped: false, description: "", icon: "", power: 0 },
  ], quests: [], npcs: [], sceneObjects: [], locations: [], dice: null, turnNumber: 2,
  payload: parseResolution(JSON.stringify({ stateChanges: { inventory: [
    { op: "consume", ref: "missing", name: "Противоядие", quantity: 1 },
    { op: "remove", ref: "retained", name: "Противоядие", quantity: 1 },
    { op: "consume", ref: "medicine", name: "Противоядие", quantity: 1 },
  ] } })).payload };
  const before = structuredClone(input);
  const result = applyResolution(input);
  assert.deepEqual(result.consumedItems, [{ id: "medicine", name: "Противоядие", kind: "consumable" }]);
  assert.deepEqual(result.applied.inventory.map(({ op, name, quantity, ok }) => ({ op, name, quantity, ok })), [
    { op: "consume", name: "Противоядие", quantity: 1, ok: false },
    { op: "remove", name: "Противоядие", quantity: 1, ok: true },
    { op: "consume", name: "Противоядие", quantity: 1, ok: true },
  ]);
  assert.deepEqual(result.ops.filter(op => op.t.startsWith("inv.")), [{ t: "inv.delete", id: "retained" }, { t: "inv.update", id: "medicine", patch: { quantity: 1 } }]);
  assert.deepEqual(input, before);
});

test("performTurn consumes the explicit same-name item and persists the cure decision seen by verification", async t => {
  const { performTurn } = await import("../src/lib/turn");
  const { emptyChanges } = await import("../src/lib/resolution");
  const db = await accountsDb();
  const { pg } = db;
  try {
    for (const kind of ["tool", "consumable"] as const) await t.test(`explicit ${kind} consumed with opposite-kind namesake retained`, async () => {
      const sessionId = randomUUID(), retainedId = randomUUID(), consumedId = randomUUID();
      const retainedKind = kind === "tool" ? "consumable" : "tool";
      await pg.query("INSERT INTO game_sessions(id,title,campaign_mode,rules_profile,character,world_state,turn_count,owner_id) VALUES ($1,'Medicine','free','narrative',$2,$3,1,'medicine-fixture')", [sessionId, JSON.stringify(hero(["отравлен"])), JSON.stringify(world())]);
      // Put the namesake first; its kind must never stand in for the explicit consumed row.
      await pg.query("INSERT INTO inventory_items(id,session_id,name,kind,quantity) VALUES ($1,$2,'Противоядие',$3,1),($4,$2,'Противоядие',$5,1)", [retainedId, sessionId, retainedKind, consumedId, kind]);
      const narration = kind === "consumable" ? "Ты принял противоядие. Отравление прошло." : "Ты принял противоядие. Отравление осталось.";
      const draft = { continuity: { mode: "event", referencesPast: false }, outcome: "neutral", effects: { hp: 0, xp: 0, gold: 0, danger: 0 }, stateChanges: { ...emptyChanges(), inventory: [{ op: "consume", ref: consumedId, name: "Противоядие", quantity: 1 }], conditions: { add: [], remove: ["отравлен"] }, time: { advanceMinutes: 5 } }, choices: ["Осмотреться"], narration };
      const checked: Record<string, unknown>[] = [];
      const fetchMock = mock.method(globalThis, "fetch", async (url: unknown) => {
        assert.equal(String(url), "https://openrouter.ai/api/v1/chat/completions");
        return Response.json({ choices: [{ message: { content: JSON.stringify(draft) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
      });
      try {
        const result = await performTurn({ sessionId, requestId: randomUUID(), expectedTurn: 1, isFree: true, action: "Принимаю противоядие" }, {
          loadAIConfig: async () => ({ keys: [], dbKeyCount: 0, envKeyCount: 0, useLiveAI: true, canUseLive: true, textProvider: "openrouter", textModel: "synthetic/medicine", textApiKey: "synthetic-key", routingConfig: { profile: "balanced", narrationModel: "gemini-3.5-flash-lite", customActionModel: "gemini-3.8-flash", compactionModel: "gemini-3.8-flash", fastTaskModel: "gemini-3.5-flash-lite" }, limits: { flash: 20, lite: 500 }, enforceLimits: false, embeddingsEnabled: false, embeddingModel: "gemini-embedding-2", embeddingDims: 768, semanticExtractionEnabled: true }),
          loadNarrativeConfig: async () => ({ enabled: true, provider: "openrouter", apiKey: "synthetic-verifier" }),
          verifyNarrative: async input => { checked.push(structuredClone(input.state)); return { status: "verified", provider: "openrouter", model: "typesafe/jev-1.13", answers: {}, latencyMs: 1 }; }, schedule() {}, scheduleDiagnostics() {},
        });
        assert.ok(result.ok, JSON.stringify(result));
        assert.deepEqual((await pg.query("SELECT id,kind,quantity FROM inventory_items WHERE session_id=$1", [sessionId])).rows, [{ id: retainedId, kind: retainedKind, quantity: 1 }]);
        const expectedConditions = kind === "consumable" ? [] : ["отравлен"];
        assert.equal(checked.length, 1);
        const accepted = checked[0].accepted_changes as { character: CharacterState; conditions: { removed: string[] } };
        assert.deepEqual(accepted.character.conditions, expectedConditions);
        assert.deepEqual(accepted.conditions.removed, kind === "consumable" ? ["отравлен"] : []);
        assert.deepEqual(result.state?.character.conditions, expectedConditions);
        assert.deepEqual(result.applied?.conditions.removed, kind === "consumable" ? ["отравлен"] : []);
        const saved = (await pg.query<{ character: CharacterState }>("SELECT character FROM game_sessions WHERE id=$1", [sessionId])).rows[0];
        assert.deepEqual(saved.character.conditions, expectedConditions);
        assert.equal(result.narration, narration);
        assert.equal((await pg.query<{ content: string }>("SELECT content FROM game_turns WHERE session_id=$1 AND role='narrator'", [sessionId])).rows[0].content, narration);
        assert.equal((await pg.query<{ content: string }>("SELECT content FROM memory_nodes WHERE session_id=$1 AND entity_key='character:conditions'", [sessionId])).rows[0].content,
          kind === "consumable" ? "У Мира нет активных состояний (ход 2)." : "Текущие состояния Мира: отравлен (обновлено на ходу 2).");
        assert.equal((await pg.query<{ payload: { narration: string } }>("SELECT payload FROM memory_jobs WHERE session_id=$1", [sessionId])).rows[0].payload.narration, narration);
      } finally { fetchMock.mock.restore(); }
    });
  } finally { await db.close(); }
});
