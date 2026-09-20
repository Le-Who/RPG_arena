import test from "node:test";
import assert from "node:assert/strict";
import { readNarrativeDraft, completeNarrativePrefix, parseCompleteNarrativeDraft } from "../src/lib/narrative-stream";

const header = { continuity: { mode: "description", referencesPast: false }, outcome: "neutral", effects: { hp: 0, gold: 0, xp: 0, danger: 0 }, stateChanges: {}, choices: ["Осмотреться"] };

test("only complete metadata preceding top-level narration is admitted", () => {
  const json = JSON.stringify({ ...header, narration: "Туман. Тихо." });
  for (let n = 0; n <= json.length; n++) {
    const parsed = readNarrativeDraft(json.slice(0, n));
    if (parsed.header) assert.deepEqual(parsed.header, header);
    assert.ok("Туман. Тихо.".startsWith(parsed.text));
  }
  assert.equal(readNarrativeDraft(json).text, "Туман. Тихо.");
  assert.equal(readNarrativeDraft('{"narration":"Сначала текст"}').header, null);
});

test("nested narration and braces in escaped strings do not impersonate top-level fields", () => {
  const unusual = { ...header, stateChanges: { note: '{"narration":"false"}', narration: "nested" } };
  const draft = readNarrativeDraft(JSON.stringify({ ...unusual, narration: 'Туман "густой".\n🌲' }));
  assert.deepEqual(draft.header, unusual);
  assert.equal(draft.text, 'Туман "густой".\n🌲');
});

test("incomplete escapes and duplicate keys withhold unsafe admission", () => {
  const prefix = JSON.stringify(header).slice(0, -1);
  assert.equal(readNarrativeDraft(prefix + ',"narration":"Лес\\u002').text, "Лес");
  assert.equal(readNarrativeDraft(prefix + ',"narration":"Лес\\').text, "Лес");
  assert.equal(readNarrativeDraft(prefix + ',"outcome":"success","narration":"Текст"}').header, null);
  assert.equal(readNarrativeDraft(prefix + ',"narration":"Лес\\uD83D').text, "Лес");
});

test("sentence buffering holds unfinished assertions and never flushes arbitrary partial tails", () => {
  assert.equal(completeNarrativePrefix("Туман окутывает лес. Ты получ"), "Туман окутывает лес.");
  assert.equal(completeNarrativePrefix("Ты получил"), "");
  assert.equal(completeNarrativePrefix("Вдали шумит дождь!\nТихо."), "Вдали шумит дождь!\nТихо.");
});

test("final draft rejects duplicate metadata after narration and nested duplicate effects", () => {
  const valid = JSON.stringify({ ...header, narration: "Туман." });
  assert.equal(parseCompleteNarrativeDraft(valid)?.narration, "Туман.");
  assert.equal(parseCompleteNarrativeDraft(valid.slice(0, -1) + ',"outcome":"success"}'), null);
  assert.equal(parseCompleteNarrativeDraft(valid.replace('"hp":0', '"hp":0,"hp":10')), null);
  assert.equal(parseCompleteNarrativeDraft(valid + ' trailing'), null);
  assert.equal(parseCompleteNarrativeDraft(valid.slice(0, -1)), null);
  assert.equal(parseCompleteNarrativeDraft(JSON.stringify({ narration: "Туман.", ...header })), null);
  assert.equal(parseCompleteNarrativeDraft(valid.replace('"hp":0', '"hp":0,"\\u0068p":10')), null);
});
