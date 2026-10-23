import { test } from "node:test";
import assert from "node:assert/strict";
import { applyResolution, parseResolution, type ApplyInput } from "../src/lib/resolution";
import { gateConditionRemovals } from "../src/lib/conditions";
import { checkInteraction, inferInteraction, interactionText, type InteractionState } from "../src/lib/interactions";

const scene: InteractionState = { currentLocation: "Кафе", inventory: [], npcs: [], sceneObjects: [], locations: [] };

for (const minutes of [90, 150, 1000, 10080]) {
  test(`waiting ${minutes} minutes retains its full duration through the action text`, () => {
    const action = interactionText({ verb: "wait", target: { kind: "none", ref: "", name: "" }, minutes });
    const checked = checkInteraction(inferInteraction(action, scene), scene);
    assert.equal(checked.defaultMinutes, minutes);
  });
}

for (const [action, minutes] of [
  ["Подождать 1000 минут", 1000], ["Подождать 20000 минут", 10080], ["Подождать 1 час и 30 минут", 90],
  ["Подождать 1,5 часа", 90], ["Подождать 1.5 ч", 90], ["Подождать 30,5 минут", 31], ["Подождать -5 минут", 0],
] as const) {
  test(`explicit waiting duration is bounded without dropping digits: ${action}`, () => {
    assert.equal(checkInteraction(inferInteraction(action, scene), scene).defaultMinutes, minutes);
  });
}

for (const action of ["Отдохнуть 2 часа", "Отдохну 2 часа", "Выпить зелье лечения", "Выпиваю зелье лечения"]) {
  test(`completed recovery accepts the ordinary action wording: ${action}`, () => {
    const rest = action.startsWith("Отдох");
    const result = gateConditionRemovals([rest ? "устал" : "ранен"], {
      intent: "act", action, minutes: rest ? 120 : 5, goldSpent: 0, dice: null,
      consumed: rest ? [] : [{ name: "Зелье лечения", kind: "consumable" }],
      narration: rest ? "Ты отдохнул два часа." : "Ты выпил зелье лечения.",
    });
    assert.deepEqual(result.restored, []);
  });
}

test("ordinary recovery wording still requires a completed hero event and real resources", () => {
  const evidence = { intent: "act" as const, minutes: 120, goldSpent: 0, dice: null, consumed: [], action: "Отдохнуть 2 часа", narration: "Ты не отдохнул два часа." };
  assert.deepEqual(gateConditionRemovals(["устал"], evidence).restored, ["устал"]);
  assert.deepEqual(gateConditionRemovals(["устал"], { ...evidence, narration: "Марта отдохнула два часа." }).restored, ["устал"]);
  assert.deepEqual(gateConditionRemovals(["ранен"], { ...evidence, minutes: 5, action: "Выпить зелье лечения", narration: "Ты выпил зелье лечения." }).restored, ["ранен"]);
});

function consumption(quantity: number, owned = 3, hp = 5): ReturnType<typeof applyResolution> {
  const input: ApplyInput = {
    rulesProfile: "d20", campaignMode: "preset", turnNumber: 2, dice: null,
    character: { name: "Мира", archetype: "Курьер", level: 1, xp: 0, hp, maxHp: 40, gold: 0, stats: {}, skills: [], traits: [], backstory: "", appearance: "", conditions: [] },
    world: { worldName: "Город", tone: "обыденность", era: "сейчас", mainQuest: "", currentLocation: "Кафе", factions: [], flags: {}, danger: 0, chapter: 1 },
    inventory: [{ id: "aaaaaaaa-0000-0000-0000-000000000000", name: "Аптечка", kind: "consumable", description: "Восстанавливает 10 HP", power: 10, quantity: owned, equipped: false, icon: "🧪" }],
    quests: [], npcs: [], sceneObjects: [], locations: [],
    payload: parseResolution(JSON.stringify({ stateChanges: { inventory: [{ op: "consume", ref: "#aaaaaa", quantity }] } })).payload,
  };
  return applyResolution(input);
}

test("consuming a stack applies healing for each unit actually consumed", () => {
  const result = consumption(2);
  assert.equal(result.character.hp, 25);
  assert.equal(result.applied.hp, 20);
  assert.deepEqual(result.ops, [{ t: "inv.update", id: "aaaaaaaa-0000-0000-0000-000000000000", patch: { quantity: 1 } }]);
});

test("stack healing respects owned quantities and maximum health", () => {
  assert.equal(consumption(3, 2).character.hp, 25);
  assert.equal(consumption(3, 3, 35).character.hp, 40);
});
