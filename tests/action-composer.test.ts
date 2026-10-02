import { test } from "node:test";
import assert from "node:assert/strict";
import { appendActionPhrase, actionEntitySuggestions, completeActionEntity } from "../src/lib/action-composer";
import type { InteractionState } from "../src/lib/interactions";

const state: InteractionState = {
  currentLocation: "Гавань",
  inventory: [{ id: "key", name: "Медный ключ", quantity: 1 }],
  npcs: [{ key: "mara", name: "Мара", status: "alive" }],
  locations: [{ id: "market", name: "Рыночная площадь", current: false, discovered: true }, { id: "secret", name: "Тайная комната", current: false, discovered: false }],
  sceneObjects: [{ key: "door", name: "Медная дверь", state: "закрыта", locationName: "Гавань" }, { key: "hidden", name: "Медный сундук", state: "закрыт", locationName: "Другое место" }],
};

test("ready phrases append without losing an unfinished draft or exceeding the action limit", () => {
  assert.equal(appendActionPhrase("Я прошу помощи", "Поговорить с «Мара»"), "Я прошу помощи\nПоговорить с «Мара»");
  assert.equal(appendActionPhrase("", "Использовать «Медный ключ»: "), "Использовать «Медный ключ»: ");
  assert.equal(appendActionPhrase("а".repeat(1990), "Поговорить с «Мара»"), null);
});

test("typing a name suggests real known entities and excludes unseen places and distant objects", () => {
  const matches = actionEntitySuggestions("Я использую Мед", 15, state);
  assert.deepEqual(matches.map(match => [match.kind, match.name]), [["item", "Медный ключ"], ["object", "Медная дверь"]]);
  assert.equal(actionEntitySuggestions("Иду в Тай", 9, state).length, 0);
  assert.equal(actionEntitySuggestions("Поговорить с Ма", 15, state)[0]?.name, "Мара");
  assert.equal(actionEntitySuggestions("Иду на Рыночную", 15, state).length, 0);
  assert.equal(actionEntitySuggestions("Иду на рыно", 11, state)[0]?.name, "Рыночная площадь");
});

test("completion replaces just the partial name at the caret and preserves the rest of the draft", () => {
  const text = "Я говорю с Ма и жду ответа";
  const suggestion = actionEntitySuggestions(text, 13, state)[0];
  assert.ok(suggestion);
  assert.deepEqual(completeActionEntity(text, suggestion), { text: "Я говорю с «Мара» и жду ответа", caret: 17 });
  const quoted = "Использовать «Мед» осторожно";
  const item = actionEntitySuggestions(quoted, 17, state)[0];
  assert.ok(item);
  assert.equal(completeActionEntity(quoted, item)?.text, "Использовать «Медный ключ» осторожно");
});

test("completion refuses overlong drafts and offers no one-character or already complete names", () => {
  assert.equal(actionEntitySuggestions("М", 1, state).length, 0);
  assert.equal(actionEntitySuggestions("Мара", 4, state).length, 0);
  const match = actionEntitySuggestions("Ма", 2, state)[0];
  assert.equal(completeActionEntity("Ма" + " ".repeat(1998), match), null);
});
