import { test } from "node:test";
import assert from "node:assert/strict";
import { assessRisk } from "../src/lib/profiles";
import { serverCheck } from "../src/lib/engine";

test("plain observation does not require a check solely because scene danger is high", () => {
  for (const playerAction of ["осматриваю комнату", "Тихо осматриваю комнату.", "Смотрю по сторонам", "Внимательно оглядываюсь", "Осмотреться внимательнее", "Осмотреться"]) {
    assert.equal(assessRisk(playerAction, 95), "safe", playerAction);
    for (const rulesProfile of ["d20", "rules-light"]) {
      assert.equal(serverCheck({ rulesProfile, playerAction, danger: 95, turnCount: 4, stats: {} }), null, playerAction);
    }
  }
});

test("contested observations and ambiguous actions preserve authoritative checks", () => {
  for (const playerAction of ["незаметно осматриваю комнату", "осматриваю комнату под обстрелом", "осматриваю комнату и атакую охранника", "прошу выдать мне штаны", "открываю дверь"]) {
    assert.notEqual(assessRisk(playerAction, 95), "safe", playerAction);
    for (const rulesProfile of ["d20", "rules-light"]) {
      assert.notEqual(serverCheck({ rulesProfile, playerAction, danger: 95, turnCount: 4, stats: {} }), null, playerAction);
    }
  }
  assert.notEqual(serverCheck({ rulesProfile: "d20", playerAction: "открываю дверь", danger: 10, turnCount: 4, stats: {} }), null);
  assert.equal(assessRisk("атакую охранника", 95), "desperate");
  assert.equal(serverCheck({ rulesProfile: "narrative", playerAction: "атакую охранника", danger: 95, turnCount: 4, stats: {} }), null);
});

test("a check retains the player's exact goal independently of model narration", () => {
  for (const rulesProfile of ["d20", "rules-light"]) {
    const action = "Убедить стражника отдать медный ключ";
    const dice = serverCheck({ rulesProfile, playerAction: action, danger: 80, turnCount: 7, stats: {} });
    assert.equal(dice?.goal, action);
  }
});
