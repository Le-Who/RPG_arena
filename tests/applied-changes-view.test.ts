import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppliedChips } from "../src/components/applied-changes";
import type { AppliedChanges } from "../src/db/schema";

test("long applied feedback stays compact but every consequence is available in disclosure", () => {
  const applied: AppliedChanges = { hp: 1, xp: 2, gold: 3, danger: -4, levelUp: true, dead: false, location: { from: "Площадь", to: "Порт", isNew: false }, inventory: [], quests: [], npcs: [], sceneObjects: [], conditions: { added: [], removed: [] }, rejected: ["Неподтверждённый предмет"] };
  const html = renderToStaticMarkup(createElement(AppliedChips, { applied }));
  assert.equal((html.match(/gx-applied-chip /g) ?? []).length, 5);
  assert.match(html, /<details class="gx-change-details">/);
  assert.match(html, /Порт/);
  assert.match(html, /Неподтверждённый предмет/);
});
