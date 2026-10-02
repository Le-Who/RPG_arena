import assert from "node:assert/strict";
import test from "node:test";
import { parseUpdateDraft, saveUpdateDraft, takeUpdateDraft, takeUpdateDraftWhenSafe, UPDATE_DRAFT_KEY } from "../src/lib/update-draft";
import { createWorkspaceLoadGate } from "../src/lib/ui-identity";

const draft = { profileId: "profile-a", campaignId: "campaign-a", action: "Использовать «Ключ»", itemBindings: [{ id: "item-a", name: "Ключ" }] };
test("update draft is bounded, expires, and never crosses identity/campaign", () => {
  const raw = JSON.stringify({ ...draft, savedAt: 1000 });
  assert.deepEqual(parseUpdateDraft(raw, "profile-a", "campaign-a", 1100)?.itemBindings, draft.itemBindings);
  assert.equal(parseUpdateDraft(raw, "profile-b", "campaign-a", 1100), null);
  assert.equal(parseUpdateDraft(raw, "profile-a", "campaign-b", 1100), null);
  assert.equal(parseUpdateDraft(raw, "profile-a", "campaign-a", 86401001), null);
  assert.equal(parseUpdateDraft(JSON.stringify({ ...draft, action: "x".repeat(2001), savedAt: 1000 }), "profile-a", "campaign-a", 1100), null);
});
test("pending recovery preserves the saved draft until it can safely restore", () => {
  let raw: string | null = JSON.stringify({ ...draft, savedAt: 1000 });
  const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; }, removeItem: () => { raw = null; } };
  assert.equal(takeUpdateDraftWhenSafe(storage, draft.profileId, draft.campaignId, false, 1100), null);
  assert.notEqual(raw, null);
  assert.deepEqual(takeUpdateDraftWhenSafe(storage, draft.profileId, draft.campaignId, true, 1100), draft);
  assert.equal(raw, null);
});
test("completed current identity refresh is not blocked by an older hung refresh", () => {
  const gate = createWorkspaceLoadGate();
  const old = gate.begin();
  const current = gate.begin();
  gate.finish(current);
  assert.equal(gate.isPending(), false);
  const newest = gate.begin();
  gate.finish(old);
  assert.equal(gate.isPending(), true);
  gate.finish(newest);
  assert.equal(gate.isPending(), false);
});
test("draft is consumed once; mismatched identity removes it; unavailable storage refuses nonempty draft", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); } };
  saveUpdateDraft(storage, draft, 1000);
  assert.equal(takeUpdateDraft(storage, "profile-a", "campaign-a", 1100)?.action, draft.action);
  assert.equal(takeUpdateDraft(storage, "profile-a", "campaign-a", 1100), null);
  saveUpdateDraft(storage, draft, 1000);
  assert.equal(takeUpdateDraft(storage, "profile-b", "campaign-a", 1100), null);
  assert.equal(values.has(UPDATE_DRAFT_KEY), false);
  assert.throws(() => saveUpdateDraft({ ...storage, setItem() { throw new Error("denied"); } }, draft));
});
