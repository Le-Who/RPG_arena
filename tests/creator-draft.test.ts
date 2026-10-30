import test from "node:test";
import assert from "node:assert/strict";
import { INITIAL_STORY_FORM, creatorDraftKey, parseCreatorDraft, saveCreatorDraft, type CreatorDraft } from "../src/lib/creator-draft";

const draft: CreatorDraft = { profileId: "guest:alice", mode: "free", scenarioId: "ashen-crown", characterIndex: 0, step: 2, storyKind: "open-life", published: false, form: { ...INITIAL_STORY_FORM, title: "  Мой мир  ", pitch: "на", name: "Ада", skills: "а, б, в, г, д, е, ж" } };
test("creator drafts preserve incomplete input exactly, steps and choices across reads", () => {
  const entries = new Map<string, string>();
  const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
  saveCreatorDraft(storage, draft, 1000);
  const raw = storage.getItem(creatorDraftKey("free"));
  assert.deepEqual(parseCreatorDraft(raw, draft.profileId, "free", 1001), draft);
  assert.equal(parseCreatorDraft(raw, "guest:bob", "free", 1001), null);
  assert.equal(parseCreatorDraft(raw, draft.profileId, "preset", 1001), null);
  assert.equal(parseCreatorDraft(raw, draft.profileId, "free", 8 * 86400000), null);
  assert.equal(parseCreatorDraft(raw, draft.profileId, "free", 999), null);
});
test("malformed or excessive local data never becomes a creator draft", () => {
  for (const patch of [{ version: 9 }, { step: 3 }, { published: "yes" }, { characterIndex: 999 }, { form: { ...draft.form, title: "x".repeat(81) } }, { form: { ...draft.form, rulesProfile: "unknown" } }]) {
    assert.equal(parseCreatorDraft(JSON.stringify({ version: 1, savedAt: 1000, ...draft, ...patch }), draft.profileId, "free", 1001), null);
  }
  assert.equal(parseCreatorDraft("{bad", draft.profileId, "free"), null);
  assert.equal(parseCreatorDraft("x".repeat(20000), draft.profileId, "free"), null);
});
test("storage denial and unconfirmed writes are reported instead of claiming autosave", () => {
  assert.throws(() => saveCreatorDraft({ getItem: () => null, setItem: () => {} }, draft), /сохранить/i);
  assert.throws(() => saveCreatorDraft({ getItem: () => null, setItem: () => { throw new Error("denied"); } }, draft), /denied/);
});
