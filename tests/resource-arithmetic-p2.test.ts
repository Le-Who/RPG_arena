import test from "node:test";
import assert from "node:assert/strict";
import type { DiceResult } from "../src/db/schema";
import { dcFor } from "../src/lib/dice";
import { runOfflineEngine, serverCheck } from "../src/lib/engine";
import { assessRisk } from "../src/lib/profiles";
import { applyResolution, parseResolution, type ApplyInput } from "../src/lib/resolution";

function input(overrides: Partial<ApplyInput> = {}): ApplyInput {
  return {
    rulesProfile: "d20", campaignMode: "free", turnNumber: 4, dice: null,
    character: { name: "Ада", archetype: "Исследователь", level: 1, xp: 0, hp: 30, maxHp: 40, gold: 15, stats: { СИЛ: 10 }, skills: [], traits: [], backstory: "", appearance: "", conditions: [] },
    world: { worldName: "Город", tone: "спокойный", era: "сегодня", mainQuest: "Найти архив", currentLocation: "Площадь", factions: [], flags: {}, danger: 30, chapter: 1 },
    inventory: [], quests: [], npcs: [], sceneObjects: [], locations: [],
    payload: parseResolution("{}").payload,
    ...overrides,
  };
}

function checkedApply(value: ApplyInput) {
  const before = structuredClone(value);
  const result = applyResolution(value);
  assert.deepEqual(value, before, "the reducer must preserve its caller's complete snapshot");
  return result;
}

function payload(effects: Record<string, number>) {
  return parseResolution(JSON.stringify({ outcome: "neutral", effects })).payload;
}

// Catches removing HP saturation, changing <= to < at zero, or losing the recovery penalty.
for (const row of [
  { name: "damage leaves one HP", hp: 11, effect: -10, wantHp: 1, dead: false, gold: 15, delta: -10 },
  { name: "exact zero triggers recovery", hp: 10, effect: -10, wantHp: 1, dead: true, gold: 5, delta: -9 },
  { name: "overkill triggers recovery", hp: 9, effect: -10, wantHp: 1, dead: true, gold: 5, delta: -8 },
  { name: "healing stops exactly at maximum", hp: 30, effect: 10, wantHp: 40, dead: false, gold: 15, delta: 10 },
  { name: "healing above maximum saturates", hp: 39, effect: 10, wantHp: 40, dead: false, gold: 15, delta: 1 },
  { name: "healing at maximum has no effect", hp: 40, effect: 10, wantHp: 40, dead: false, gold: 15, delta: 0 },
]) {
  test(`resource arithmetic: ${row.name}`, () => {
    const value = input();
    value.character.hp = row.hp;
    value.payload = payload({ hp: row.effect, xp: 1 });
    const result = checkedApply(value);
    assert.equal(result.character.hp, row.wantHp);
    assert.equal(result.character.maxHp, 40);
    assert.equal(result.character.gold, row.gold);
    assert.equal(result.applied.hp, row.delta);
    assert.equal(result.applied.dead, row.dead);
    assert.deepEqual(result.applied.resources?.hp, { before: row.hp, after: row.wantHp, maxBefore: 40, maxAfter: 40 });
    assert.equal(result.events.filter(event => event.entityKey === "death:4").length, row.dead ? 1 : 0);
  });
}

// Hand-counted thresholds catch premature/delayed levels and omitted level-up healing.
for (const row of [
  { xp: 118, level: 1, wantXp: 119, wantLevel: 1, hp: 30, maxHp: 40, levelUp: false },
  { xp: 119, level: 1, wantXp: 120, wantLevel: 2, hp: 35, maxHp: 45, levelUp: true },
  { xp: 120, level: 2, wantXp: 121, wantLevel: 2, hp: 30, maxHp: 40, levelUp: false },
  { xp: 238, level: 2, wantXp: 239, wantLevel: 2, hp: 30, maxHp: 40, levelUp: false },
  { xp: 239, level: 2, wantXp: 240, wantLevel: 3, hp: 35, maxHp: 45, levelUp: true },
]) {
  test(`resource arithmetic: XP ${row.xp} plus one reaches level ${row.wantLevel}`, () => {
    const value = input();
    Object.assign(value.character, { xp: row.xp, level: row.level });
    value.payload = payload({ xp: 1 });
    const result = checkedApply(value);
    assert.equal(result.character.xp, row.wantXp);
    assert.equal(result.character.level, row.wantLevel);
    assert.equal(result.character.hp, row.hp);
    assert.equal(result.character.maxHp, row.maxHp);
    assert.equal(result.applied.levelUp, row.levelUp);
    assert.equal(result.applied.xp, 1);
    assert.equal(result.events.filter(event => event.entityKey === "character:level").length, row.levelUp ? 1 : 0);
  });
}

// Catches turn escalation beyond its cap and the final DC cap being removed.
for (const row of [
  { danger: 100, turn: 23, want: 16 },
  { danger: 100, turn: 24, want: 17 },
  { danger: 100, turn: 800, want: 17 },
  { danger: 150, turn: 24, want: 19 },
  { danger: 175, turn: 24, want: 20 },
  { danger: 200, turn: 24, want: 20 },
]) {
  test(`resource arithmetic: DC at danger ${row.danger}, turn ${row.turn} is ${row.want}`, () => {
    assert.equal(dcFor(row.danger, row.turn), row.want);
    const check = serverCheck({ rulesProfile: "d20", playerAction: "Открываю дверь", stats: {}, danger: row.danger, turnCount: row.turn });
    assert.equal(check?.dc, row.want, "the real server check consumes the bounded DC");
  });
}

// Catches >= becoming > at 60/70 and accidental checks for ordinary observation.
for (const row of [
  { action: "Атакую охранника", danger: 59, risk: "risky", modifier: 0 },
  { action: "Атакую охранника", danger: 60, risk: "desperate", modifier: -1 },
  { action: "Атакую охранника", danger: 61, risk: "desperate", modifier: -1 },
  { action: "Открываю дверь", danger: 69, risk: "safe", modifier: null },
  { action: "Открываю дверь", danger: 70, risk: "risky", modifier: 0 },
  { action: "Открываю дверь", danger: 71, risk: "risky", modifier: 0 },
  { action: "Убеждаю архивариуса", danger: 70, risk: "risky", modifier: 0 },
  { action: "Осматриваю комнату", danger: 70, risk: "safe", modifier: null },
]) {
  test(`resource arithmetic: ${row.action}, danger ${row.danger} gives ${row.risk}`, () => {
    assert.equal(assessRisk(row.action, row.danger), row.risk);
    const check = serverCheck({ rulesProfile: "rules-light", playerAction: row.action, stats: {}, danger: row.danger, turnCount: 4 });
    if (row.modifier === null) assert.equal(check, null);
    else {
      assert.equal(check?.kind, "2d6");
      assert.equal(check?.modifier, row.modifier);
    }
    assert.equal(serverCheck({ rulesProfile: "narrative", playerAction: row.action, stats: {}, danger: row.danger, turnCount: 4 }), null);
  });
}

const success: DiceResult = { kind: "d20", d20: 18, modifier: 0, total: 18, dc: 12, success: true, critical: null, skill: "Убеждение", band: "full", label: "Успех" };
const failure: DiceResult = { ...success, d20: 3, total: 3, success: false, band: "fail", label: "Неудача" };

// Catches trusting model success over failed server dice or granting successful rewards on failure.
for (const campaignMode of ["preset", "free"] as const) {
  for (const row of [
    { name: "successful", dice: success, outcome: "success", hp: 40, xp: 60, gold: 135, danger: 28, item: true },
    { name: "failed", dice: failure, outcome: "failure", hp: 30, xp: 10, gold: 15, danger: 34, item: false },
  ]) {
    test(`resource arithmetic: ${campaignMode} ${row.name} check controls proposed rewards`, () => {
      const value = input({ campaignMode, dice: row.dice });
      value.payload = parseResolution(JSON.stringify({ outcome: "success", effects: { hp: 100, xp: 500, gold: 900 }, stateChanges: { inventory: [{ op: "add", name: "Письмо", kind: "quest", quantity: 1 }] } })).payload;
      const result = checkedApply(value);
      assert.equal(result.outcome, row.outcome);
      assert.deepEqual({ hp: result.character.hp, xp: result.character.xp, gold: result.character.gold, danger: result.world.danger }, { hp: row.hp, xp: row.xp, gold: row.gold, danger: row.danger });
      assert.equal(result.applied.inventory[0]?.ok, row.item);
      assert.equal(result.ops.filter(op => op.t === "inv.insert").length, row.item ? 1 : 0);
      assert.deepEqual(result.applied.resources?.xp, { before: 0, after: row.xp });
      assert.equal(result.applied.resources?.level, undefined);
    });
  }
}

// Catches accidental numeric resources/levels being enabled in optional-rules profiles.
for (const campaignMode of ["preset", "free"] as const) {
  for (const row of [
    { profile: "rules-light", hp: 40, xp: 119, gold: 95 },
    { profile: "narrative", hp: 30, xp: 119, gold: 15 },
  ]) {
    test(`resource arithmetic: ${campaignMode} ${row.profile} preserves disabled counters without a check`, () => {
      const value = input({ campaignMode, rulesProfile: row.profile });
      value.character.xp = 119;
      value.payload = payload({ hp: 100, xp: 500, gold: 900 });
      const result = checkedApply(value);
      assert.deepEqual({ hp: result.character.hp, xp: result.character.xp, gold: result.character.gold, level: result.character.level, maxHp: result.character.maxHp }, { hp: row.hp, xp: row.xp, gold: row.gold, level: 1, maxHp: 40 });
      assert.equal(result.applied.levelUp, false);
      assert.equal(result.outcome, "neutral");
    });
  }
}

test("resource arithmetic: preset offline failure cannot produce successful gold or loot", () => {
  const value = input();
  const engineInput = { rulesProfile: "d20", playerAction: "Убеждаю архивариуса", isFreeAction: true, resolvedDice: failure, character: value.character, world: value.world, turnCount: 4, scenarioTitle: "Архив", lootPool: [{ name: "Письмо", kind: "quest", description: "Письмо из архива", icon: "📜" }] };
  const before = structuredClone(engineInput);
  const proposed = runOfflineEngine(engineInput);
  assert.deepEqual(engineInput, before);
  assert.deepEqual(proposed.dice, failure);
  assert.equal(proposed.effects.gold, 0);
  assert.equal(proposed.effects.xp, 8); // failure progress is deliberately smaller than a successful reward
  assert.deepEqual(proposed.loot, []);
  const accepted = checkedApply(input({ campaignMode: "preset", dice: proposed.dice, payload: parseResolution(JSON.stringify({ outcome: "success", effects: proposed.effects })).payload }));
  assert.equal(accepted.outcome, "failure");
  assert.equal(accepted.character.gold, 15);
  assert.equal(accepted.character.xp, 8);
  assert.equal(accepted.ops.length, 0);
});
