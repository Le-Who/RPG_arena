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

const inventoryState: InteractionState = {
  ...state,
  inventory: [
    { id: "underwear", name: "разных цветов трусики", quantity: 2 },
    { id: "key", name: "Медный ключ", quantity: 1 },
    { id: "spent", name: "Красные трусы", quantity: 0 },
  ],
};

test("inventory suggestions find an internal noun and the трусы / трусики word family", () => {
  for (const text of ["Я беру трусы", "Я беру трусики", "Я беру трусами", "Я беру цветов"])
    assert.deepEqual(actionEntitySuggestions(text, text.length, inventoryState).map(item => item.ref), ["underwear"]);
  const text = "Я беру ключ";
  assert.equal(actionEntitySuggestions(text, text.length, inventoryState)[0]?.ref, "key");
  assert.equal(actionEntitySuggestions("облако", 6, inventoryState).length, 0);
});

test("bare @ lists only available inventory and accepts short, complete and reordered item queries", () => {
  assert.deepEqual(actionEntitySuggestions("Смотрю на @", 11, inventoryState).map(item => item.ref), ["underwear", "key"]);
  for (const text of ["@т", "@трусы", "@цветов трусы", "@разных цветов трусики"])
    assert.equal(actionEntitySuggestions(text, text.length, inventoryState)[0]?.ref, "underwear");
  assert.equal(actionEntitySuggestions("@Ма", 3, inventoryState).length, 0);
  assert.equal(actionEntitySuggestions("почта user@трусы", 16, inventoryState).length, 0);
});

test("selecting @ inventory replaces only the mention query with a canonical name and exact item identity", () => {
  const text = "Показываю @трусы и улыбаюсь";
  const match = actionEntitySuggestions(text, "Показываю @трусы".length, inventoryState)[0];
  assert.ok(match);
  assert.equal(match.ref, "underwear");
  assert.deepEqual(completeActionEntity(text, match), {
    text: "Показываю «разных цветов трусики» и улыбаюсь",
    caret: "Показываю «разных цветов трусики»".length,
  });
  const at = actionEntitySuggestions("Достаю @.", 8, inventoryState)[0];
  assert.equal(completeActionEntity("Достаю @.", at)?.text, "Достаю «разных цветов трусики».");
});

test("@ completion does not consume unrelated prose or exceed the action length limit", () => {
  const text = "@клю|ч и говорю".replace("|", "");
  const match = actionEntitySuggestions(text, 4, inventoryState)[0];
  assert.equal(completeActionEntity(text, match)?.text, "«Медный ключ» и говорю");
  const at = actionEntitySuggestions("@", 1, inventoryState)[0];
  assert.equal(completeActionEntity("@" + " ".repeat(1999), at), null);
});

test("a complete multiword inventory name is not suggested again from its final noun", () => {
  for (const text of ["Я беру Медный ключ", "Я беру разных цветов трусики"])
    assert.deepEqual(actionEntitySuggestions(text, text.length, inventoryState), []);
});

test("an @ mention inside existing quotation marks replaces those marks once", () => {
  const text = "Показываю «@трусы»";
  const match = actionEntitySuggestions(text, text.length - 1, inventoryState)[0];
  assert.ok(match);
  assert.equal(completeActionEntity(text, match)?.text, "Показываю «разных цветов трусики»");
});
