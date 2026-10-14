import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJsonObject, parseResolution } from "../src/lib/resolution";

const payload = { narration: 'Она сказала: "{да}" и закрыла дверь.', outcome: "success", effects: { hp: 0, xp: 7, gold: 2, danger: 0 } };
for (const [name, text] of [
  ["trailing explanation", `${JSON.stringify(payload)}\nПояснение после ответа.`],
  ["prefix and trailing explanation", `Ответ:\n${JSON.stringify(payload)}\nГотово.`],
  ["trailing prose contains braces", `${JSON.stringify(payload)}\nПояснение {не JSON}.`],
  ["fenced response with explanation", `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\nГотово.`],
] as const) {
  test(`resolution JSON envelope accepts ${name}`, () => {
    assert.deepEqual(extractJsonObject(text), payload);
    const parsed = parseResolution(text);
    assert.equal(parsed.parsedJson, true);
    assert.equal(parsed.payload.narration, payload.narration);
    assert.equal(parsed.payload.effects.xp, 7);
  });
}
test("resolution JSON envelope does not salvage a nested object from a malformed outer object", () => {
  assert.equal(extractJsonObject('{"narration": broken, "nested": {"effects": {"gold": 99}}}'), null);
  assert.equal(extractJsonObject('{"narration":"unfinished'), null);
  assert.equal(extractJsonObject("ordinary prose"), null);
});
