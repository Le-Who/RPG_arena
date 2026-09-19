import { test } from "node:test";
import assert from "node:assert/strict";
import { cosine, formatDocument, formatQuery, isValidVector, EMBEDDING_MODEL } from "../src/lib/vector";
import { mayReplaceMemory } from "../src/lib/memory-policy";
import { normalizeExtractedFacts } from "../src/lib/memory";
import { runOfflineEngine, serverCheck } from "../src/lib/engine";
import { SCENARIOS } from "../src/lib/scenarios";
import { applyResolution, parseResolution, type ApplyInput } from "../src/lib/resolution";
import type { CampaignMode, DiceResult, RulesProfile } from "../src/db/schema";

test("embedding contract: stable Embedding 2 and asymmetric text task prefixes", () => {
  assert.equal(EMBEDDING_MODEL, "gemini-embedding-2");
  assert.equal(formatQuery("Кто обещал помочь?"), "task: search result | query: Кто обещал помочь?");
  assert.equal(formatDocument("", "Факт"), "title: none | text: Факт");
  assert.equal(formatDocument("Мир", "x".repeat(10000)).length, 6000);
  assert.equal(formatQuery("x".repeat(10000)).length, 4000);
});
test("vector validation rejects incompatible, empty, non-finite and zero vectors", () => {
  assert.ok(isValidVector([1, 0, 0], 3));
  for (const vector of [[1], [], [0, 0, 0], [1, NaN, 0], [1, Infinity, 0], [1, "2", 3], null]) assert.equal(isValidVector(vector, 3), false);
  assert.throws(() => cosine([1], [1, 0]), RangeError);
  assert.throws(() => cosine([NaN], [1]), TypeError);
  assert.equal(cosine([0, 0], [0, 0]), 0);
  assert.equal(cosine([1, 0], [-1, 0]), -1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
});
test("memory precedence: delayed extraction never rolls back or overwrites canonical state", () => {
  assert.equal(mayReplaceMemory({ source: "state", sourceTurn: 9 }, { source: "ai-semantic", sourceTurn: 10 }), false);
  assert.equal(mayReplaceMemory({ source: "seed", sourceTurn: 1 }, { source: "compaction", sourceTurn: 10 }), false);
  assert.equal(mayReplaceMemory({ source: "ai-semantic", sourceTurn: 9 }, { source: "ai-semantic", sourceTurn: 8 }), false);
  assert.equal(mayReplaceMemory({ source: "ai-semantic", sourceTurn: 9 }, { source: "state", sourceTurn: 10 }), true);
});
test("extractor: intentions, partial quotations, NaN and malformed facts are not evidence", () => {
  const phrase = "Лена обещала встретить вас на вокзале завтра утром.";
  const fact = { type: "promise", content: phrase, evidence: phrase, confidence: .9, importance: 70 };
  assert.equal(normalizeExtractedFacts({ facts: [fact] }, phrase, "").length, 1);
  assert.equal(normalizeExtractedFacts({ facts: [fact] }, "Лена отказывается от встречи.", phrase).length, 0);
  assert.equal(normalizeExtractedFacts({ facts: [{ ...fact, evidence: phrase + " Она также передала ключ от квартиры." }] }, phrase, "").length, 0);
  assert.equal(normalizeExtractedFacts({ facts: [{ ...fact, confidence: "not-a-number" }] }, phrase, "").length, 0);
  assert.equal(normalizeExtractedFacts({ facts: [{ ...fact, confidence: Infinity }] }, phrase, "").length, 0);
  assert.equal(normalizeExtractedFacts({ facts: [{ ...fact, confidence: "0.9" }] }, phrase, "").length, 0);
  assert.equal(normalizeExtractedFacts({ facts: [null, 7, { ...fact, type: "inventory" }] }, phrase, "").length, 0);
});
test("offline engine reuses the authoritative dice result instead of rolling again", () => {
  const dice: DiceResult = { kind: "d20", d20: 1, modifier: 0, total: 1, dc: 15, success: false, critical: "fumble", skill: "Анализ", label: "Проверка" };
  const scenario = SCENARIOS.find((s) => s.id === "ashen-crown")!;
  let previous: ReturnType<typeof runOfflineEngine> | null = null;
  for (let i = 0; i < 20; i++) {
    const result = runOfflineEngine({ playerAction: "Изучить документ", isFreeAction: true, resolvedDice: dice, rulesProfile: "d20", character: { name: "Кайра", archetype: "Следопыт", stats: {}, hp: 40, maxHp: 40 }, world: { worldName: scenario.worldName, currentLocation: scenario.startLocation, mainQuest: scenario.mainQuest, danger: 30, chapter: 1, tone: scenario.tone }, turnCount: 2, scenarioTitle: scenario.title, lootPool: scenario.lootPool });
    if (previous) assert.deepEqual(result, previous, "Same action, turn and authoritative check must reproduce offline flavor");
    previous = result;
    assert.equal(result.dice, dice);
    assert.ok(result.effects.hp < 0);
    assert.equal(result.loot.length, 0);
  }
});
for (const profile of ["d20", "rules-light", "narrative"] as RulesProfile[]) {
  for (const mode of ["preset", "free"] as CampaignMode[]) {
    for (const genre of ["нуар", "киберпанк", "бытовая драма", "хоррор", "научная фантастика", "фэнтези"]) {
      test(`genre/profile/mode contract: ${genre} × ${profile} × ${mode}`, () => {
        const input: ApplyInput = { rulesProfile: profile, campaignMode: mode, character: { name: "Ада", archetype: "Исследователь", level: 1, xp: 0, hp: profile === "narrative" ? 0 : 40, maxHp: profile === "narrative" ? 0 : 40, gold: 0, stats: {}, skills: [], traits: [], backstory: "", appearance: "", conditions: [] }, world: { worldName: "Авторский мир", tone: genre, era: "2026", mainQuest: "Найти ответ", currentLocation: "Заданная локация", factions: [], flags: {}, danger: 20, chapter: 1 }, inventory: [], quests: [], npcs: [], sceneObjects: [], locations: [], payload: parseResolution(JSON.stringify({ narration: "Вы замечаете деталь.", effects: { hp: 5, xp: 50, gold: 100 }, stateChanges: {} })).payload, dice: null, turnNumber: 2 };
        const result = applyResolution(input);
        assert.equal(result.world.worldName, "Авторский мир");
        assert.equal(result.world.tone, genre);
        assert.equal(result.world.currentLocation, "Заданная локация");
        assert.equal(result.character.archetype, "Исследователь");
        if (profile === "narrative") {
          assert.equal(result.applied.hp, 0); assert.equal(result.applied.xp, 0); assert.equal(result.applied.gold, 0);
          assert.equal(serverCheck({ rulesProfile: profile, playerAction: "Рискнуть и открыть дверь", stats: {}, danger: 90, turnCount: 5 }), null);
        }
      });
    }
  }
}
test("eight complete presets include non-fantasy authored worlds", () => {
  assert.equal(SCENARIOS.length, 8);
  assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, 8);
  for (const scenario of SCENARIOS) { assert.ok(scenario.characters.length >= 2); assert.ok(scenario.intro.length > 150); assert.ok(scenario.locations.length >= 3); assert.ok(scenario.startInventory.length); }
  assert.equal(SCENARIOS.find((s) => s.id === "echo-station")?.rulesProfile, "narrative");
  assert.equal(SCENARIOS.find((s) => s.id === "last-departure")?.rulesProfile, "rules-light");
});
