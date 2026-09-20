import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppliedChanges } from "../src/db/schema";
import { describeAppliedChanges } from "../src/lib/applied-changes";

const empty = (): AppliedChanges => ({ hp: 0, xp: 0, gold: 0, danger: 0, levelUp: false, dead: false, location: null, inventory: [], quests: [], npcs: [], sceneObjects: [], conditions: { added: [], removed: [] }, rejected: [] });

test("item feedback distinguishes receipt, consumption, removal, equipment and unequipment", () => {
  const changes = empty();
  changes.inventory = ["add", "consume", "remove", "equip", "unequip"].map(op => ({ op, name: "Предмет", quantity: 2, ok: true }));
  const chips = describeAppliedChanges(changes);
  assert.deepEqual(chips.map(c => c.label), ["Получено: Предмет ×2", "Израсходовано: Предмет ×2", "Удалено из инвентаря: Предмет ×2", "Экипировано: Предмет", "Снято с экипировки: Предмет"]);
  assert.equal(new Set(chips.map(c => c.icon)).size, 5);
  assert.equal(chips[0].tone, "positive");
  assert.equal(chips[1].tone, "neutral", "using a consumable is not automatically a bad outcome");
  assert.notEqual(chips[2].tone, "positive");
});

test("failed inventory changes are not presented as accomplished actions", () => {
  const changes = empty();
  changes.inventory = [{ op: "add", name: "Несуществующий приз", quantity: 1, ok: false, reason: "провал" }];
  assert.deepEqual(describeAppliedChanges(changes), []);
});

test("resource signs and tones reflect gains, losses and danger without a success checkmark", () => {
  const chips = describeAppliedChanges({ ...empty(), hp: -3, xp: -2, gold: -5, danger: 4 });
  assert.deepEqual(chips.map(c => c.label), ["Здоровье −3", "Опыт −2", "Средства −5", "Опасность +4"]);
  assert.ok(chips.every(c => c.tone === "negative"));
  assert.ok(chips.every(c => c.icon !== "check"));
  assert.ok(describeAppliedChanges({ ...empty(), hp: 3, xp: 2, gold: 5, danger: -4 }).every(c => c.tone === "positive"));
  assert.deepEqual(describeAppliedChanges(empty()), []);
});

test("quest completion and failure use explicit status, not the same progress-only success label", () => {
  const chips = describeAppliedChanges({ ...empty(), quests: [
    { title: "Поиск", status: "active", progress: 30, isNew: false },
    { title: "Спасение", status: "failed", progress: 70, isNew: false },
    { title: "Доставка", status: "completed", progress: 100, isNew: false },
    { title: "Тайна", status: "hidden", progress: 0, isNew: false },
  ] });
  assert.deepEqual(chips.map(c => c.label), ["Цель «Поиск»: прогресс 30%", "Цель провалена: Спасение", "Цель выполнена: Доставка", "Скрытая цель: Тайна"]);
  assert.equal(chips[0].tone, "neutral");
  assert.equal(chips[1].tone, "negative");
  assert.equal(chips[2].tone, "positive");
});

test("added and removed conditions are both visible without guessing whether the condition is beneficial", () => {
  const chips = describeAppliedChanges({ ...empty(), conditions: { added: ["Воодушевление"], removed: ["Отравление"] } });
  assert.deepEqual(chips.map(c => c.label), ["Состояние добавлено: Воодушевление", "Состояние снято: Отравление"]);
  assert.ok(chips.every(c => c.tone === "neutral"));
  assert.notEqual(chips[0].icon, chips[1].icon);
});

test("level-up, near-death recovery and NPC/scene changes retain their meaning", () => {
  const chips = describeAppliedChanges({ ...empty(), levelUp: true, dead: true, location: { from: "Город", to: "Лес", isNew: true }, npcs: [{ name: "Марта", relation: 3, delta: -2, status: "alive", isNew: false }], sceneObjects: [{ name: "Дверь", state: "открыта", isNew: false }] });
  assert.ok(chips.some(c => c.label === "Уровень повышен" && c.tone === "positive"));
  assert.ok(chips.some(c => c.label === "На грани гибели" && c.tone === "negative"));
  assert.ok(chips.some(c => c.label === "Переход: Город → Лес"));
  assert.ok(chips.some(c => c.label === "Отношение: Марта −2" && c.tone === "negative"));
  assert.ok(chips.some(c => c.label === "Дверь: открыта" && c.tone === "neutral"));
});
