import test from "node:test";
import assert from "node:assert/strict";
import { portableFixture, now } from "./helpers/portable-fixture";
import { createPortableDocument, parsePortableDocument } from "../src/lib/campaign-portable";
import { roll2d6, rollD20 } from "../src/lib/dice";

for (const [first, second, encoded] of [[1, 1, 11], [1, 6, 16], [3, 5, 35], [6, 1, 61], [6, 6, 66]]) test(`portable rules-light history retains encoded 2d6 roll ${encoded}`, () => {
  const snapshot = portableFixture();
  const samples = [(first - .5) / 6, (second - .5) / 6];
  snapshot.turns[0].dice = roll2d6("Риск", 0, () => samples.shift()!);
  assert.equal(snapshot.turns[0].dice.d20, encoded);
  const parsed = parsePortableDocument(JSON.parse(JSON.stringify(createPortableDocument(snapshot, now))));
  assert.deepEqual(parsed.snapshot.turns[0].dice, snapshot.turns[0].dice);
});

test("portable dice validation keeps kind-dependent bounds and legacy d20 rolls", () => {
  for (const [kind, value] of [["2d6", 0], ["2d6", 10], ["2d6", 17], ["2d6", 20], ["2d6", 67], ["d20", 21], ["d20", 35], [undefined, 66]] as const) {
    const snapshot = portableFixture();
    snapshot.turns[0].dice = { ...rollD20("Проверка", 0, 12, () => .5), kind, d20: value };
    if (kind === undefined) delete snapshot.turns[0].dice.kind;
    assert.throws(() => createPortableDocument(snapshot, now), { code: "INVALID_DOCUMENT" });
  }
  const legacy = portableFixture();
  const { kind: _kind, band: _band, ...roll } = rollD20("Проверка", 0, 12, () => .99);
  legacy.turns[0].dice = roll;
  assert.equal(parsePortableDocument(createPortableDocument(legacy, now)).snapshot.turns[0].dice!.d20, 20);
});
