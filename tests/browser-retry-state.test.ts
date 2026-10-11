import test from "node:test";
import assert from "node:assert/strict";
import { applyCommittedSnapshot } from "../src/lib/committed-turns";

test("recovered equal-turn or older ledger results cannot replace an already verified snapshot", () => {
  const verified = {
    session: { id: "campaign", turnCount: 4, character: { hp: 9 }, worldState: { currentLocation: "Сад" } },
    turns: [{ id: "durable-row", role: "narrator", turnNumber: 4, content: "Принятый рассказ" }],
    inventory: [{ id: "durable-item", name: "Ключ" }],
  };
  for (const turnNumber of [3, 4]) {
    const recovered = { turnNumber, requestId: "recovered", narration: "Старый рассказ", choices: ["Старый выбор"],
      state: { character: { hp: 1 }, worldState: { currentLocation: "Причал" } } };
    const actual = applyCommittedSnapshot(verified as never, recovered as never);
    assert.equal(actual, verified, `ledger turn ${turnNumber} must leave verified turn 4 untouched`);
    assert.equal(actual!.session.character.hp, 9);
    assert.equal(actual!.session.worldState.currentLocation, "Сад");
    assert.equal(actual!.turns[0].content, "Принятый рассказ");
  }
});
