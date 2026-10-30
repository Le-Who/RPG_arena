import { STORY_TEXT_FIELDS, type StoryDraft } from "./story-draft";
import type { StoryShapeKind } from "./world-life";

export const INITIAL_STORY_FORM: StoryDraft = { title: "", worldName: "", pitch: "", era: "", tone: "", mainQuest: "", startLocation: "", name: "", archetype: "", backstory: "", skills: "", startItems: "", rulesProfile: "narrative" };
export type CreatorDraft = {
  profileId: string; mode: "preset" | "free"; scenarioId: string; characterIndex: number;
  step: number; storyKind: StoryShapeKind; published: boolean; form: StoryDraft;
};
export const creatorDraftKey = (mode: CreatorDraft["mode"]) => `chronicle:creator-draft:v1:${mode}`;
const limits = { title: 80, worldName: 80, pitch: 2000, era: 80, tone: 80, mainQuest: 500, startLocation: 80, name: 40, archetype: 40, backstory: 800, skills: 240, startItems: 360 };

/** A draft may be incomplete or temporarily invalid for creation. Never trim it. */
export function parseCreatorDraft(raw: string | null, profileId: string, mode: CreatorDraft["mode"], now = Date.now()): CreatorDraft | null {
  if (!raw || raw.length > 16000) return null;
  try {
    const d = JSON.parse(raw);
    if (!d || d.version !== 1 || d.profileId !== profileId || typeof profileId !== "string" || !profileId || profileId.length > 100 || d.mode !== mode
      || !Number.isSafeInteger(d.savedAt) || d.savedAt > now || now - d.savedAt > 7 * 86400000
      || typeof d.scenarioId !== "string" || d.scenarioId.length > 100 || !Number.isInteger(d.characterIndex) || d.characterIndex < 0 || d.characterIndex > 20
      || ![1, 2].includes(d.step) || !["scene", "open-life", "arc"].includes(d.storyKind) || typeof d.published !== "boolean"
      || !d.form || !["narrative", "rules-light", "d20"].includes(d.form.rulesProfile)
      || STORY_TEXT_FIELDS.some(field => typeof d.form[field] !== "string" || d.form[field].length > limits[field])) return null;
    const form = Object.fromEntries(STORY_TEXT_FIELDS.map(field => [field, d.form[field]])) as Omit<StoryDraft, "rulesProfile">;
    return { profileId, mode, scenarioId: d.scenarioId, characterIndex: d.characterIndex, step: d.step, storyKind: d.storyKind, published: d.published, form: { ...form, rulesProfile: d.form.rulesProfile } };
  } catch { return null; }
}

export function saveCreatorDraft(storage: Pick<Storage, "getItem" | "setItem">, draft: CreatorDraft, now = Date.now()) {
  const raw = JSON.stringify({ ...draft, version: 1, savedAt: now });
  if (!parseCreatorDraft(raw, draft.profileId, draft.mode, now)) throw new Error("Не удалось сохранить черновик.");
  const key = creatorDraftKey(draft.mode);
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw new Error("Не удалось сохранить черновик.");
}

export function clearCreatorDrafts(storage: Pick<Storage, "removeItem">) {
  storage.removeItem(creatorDraftKey("free"));
  storage.removeItem(creatorDraftKey("preset"));
}
