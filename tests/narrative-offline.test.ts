import test from "node:test";
import assert from "node:assert/strict";
import { offlineCanonicalNarration } from "../src/lib/narrative-offline";
import type { AppliedChanges } from "../src/db/schema";

test("offline narration describes accepted inventory and exact resource deltas only", () => {
  const applied: AppliedChanges = { hp: -2, gold: 0, xp: 0, danger: 3, levelUp: false, dead: false,
    location: null, quests: [], npcs: [], sceneObjects: [], conditions: { added: [], removed: [] }, rejected: ["не получен"],
    inventory: [{ op: "add", name: "Штаны", quantity: 1, ok: false, reason: "провал" }] };
  const denied = offlineCanonicalNarration({ action: "Попросить штаны", location: "двор", outcome: "failure", applied });
  assert.match(denied, /не удалась/); assert.doesNotMatch(denied, /Получено|Надето/); assert.match(denied, /Здоровье: -2/);
  applied.inventory[0].ok = true;
  const received = offlineCanonicalNarration({ action: "Попросить штаны", location: "двор", outcome: "success", applied });
  assert.match(received, /Получено: «Штаны» ×1/);
});
