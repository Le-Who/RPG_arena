import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyAction } from "../src/lib/action-kind";
import { readPendingTurn } from "../src/components/use-turn-request";

test("action classification matches only trimmed current choices", () => {
  const choices = ["Осмотреть дверь", " Поговорить с Марой "];
  assert.deepEqual(classifyAction("  Осмотреть дверь  ", choices), { action: "Осмотреть дверь", custom: false, choice: 0 });
  assert.equal(classifyAction("Поговорить с Марой", choices).custom, false);
  for (const action of ["осмотреть дверь", "Осмотреть дверь!", "Осмотреть дверь тихо", "Использовать ключ", ""]) assert.equal(classifyAction(action, choices).custom, true);
  assert.equal(classifyAction("Осмотреть дверь", ["Уйти"]).custom, true);
});

test("pending turns retain their original routing flag even if text now matches", () => {
  const pending = { id: "old-request", sessionId: "campaign", action: "Осмотреть дверь", custom: true, expectedTurn: 3 };
  assert.deepEqual(readPendingTurn(JSON.stringify(pending), "campaign"), pending);
});
