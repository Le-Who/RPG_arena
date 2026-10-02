import test from "node:test";
import assert from "node:assert/strict";
import { PROMPT_BUDGET_SECTIONS, measurePromptBudget } from "../src/lib/prompt-budget";
import { createPortableDocument, parsePortableDocument } from "../src/lib/campaign-portable";
import { portableFixture } from "./helpers/portable-fixture";
test("strict portable JSON accepts every measured prompt section and rejects unknown ones", () => {
  const snapshot = portableFixture();
  const turn = snapshot.turns.find((row) => row.role === "narrator") ?? snapshot.turns[0];
  const promptBudget = measurePromptBudget({ system: "s", user: "u", sections: Object.fromEntries(PROMPT_BUDGET_SECTIONS.map((key) => [key, "x"])) });
  assert.equal(Object.keys(promptBudget.sections).length, PROMPT_BUDGET_SECTIONS.length);
  turn.contextMeta = { ...(turn.contextMeta ?? { model: "gemini", rulesProfile: "d20", digestChars: 0, retrievedIds: [] }), promptBudget };
  const document = JSON.parse(JSON.stringify(createPortableDocument(snapshot)));
  const parsed = parsePortableDocument(document);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)).snapshot.turns.find((row: { id: string }) => row.id === turn.id).contextMeta.promptBudget, promptBudget);
  const tampered = JSON.parse(JSON.stringify(document));
  tampered.snapshot.turns.find((row: { id: string }) => row.id === turn.id).contextMeta.promptBudget.sections.injected = 1;
  assert.throws(() => parsePortableDocument(tampered));
});
