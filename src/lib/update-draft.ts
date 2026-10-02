import type { ItemBinding } from "./item-bindings";

export const UPDATE_DRAFT_KEY = "chronicle:update-draft:v1";
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
export type UpdateDraft = { profileId: string; campaignId: string; action: string; itemBindings: ItemBinding[] };
const bounded = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
export function parseUpdateDraft(raw: string | null, profileId: string, campaignId: string, now = Date.now()): UpdateDraft | null {
  if (!raw || raw.length > 12000) return null;
  try {
    const d = JSON.parse(raw);
    if (!d || d.profileId !== profileId || d.campaignId !== campaignId || !bounded(d.profileId, 100) || !bounded(d.campaignId, 100) || typeof d.action !== "string" || d.action.length > 2000 || !Number.isSafeInteger(d.savedAt) || d.savedAt > now || now - d.savedAt > 86400000 || !Array.isArray(d.itemBindings) || d.itemBindings.length > 4 || d.itemBindings.some((i: ItemBinding) => !i || !bounded(i.id, 100) || !bounded(i.name, 300))) return null;
    return { profileId, campaignId, action: d.action, itemBindings: d.itemBindings.map((i: ItemBinding) => ({ id: i.id, name: i.name })) };
  } catch { return null; }
}
export function saveUpdateDraft(storage: Storage, draft: UpdateDraft, now = Date.now()) {
  const raw = JSON.stringify({ ...draft, savedAt: now });
  if (!parseUpdateDraft(raw, draft.profileId, draft.campaignId, now)) throw new Error("Черновик не удалось сохранить. Скопируйте текст перед обновлением.");
  storage.setItem(UPDATE_DRAFT_KEY, raw);
  if (storage.getItem(UPDATE_DRAFT_KEY) !== raw) throw new Error("Не удалось проверить сохранение черновика.");
}
export function takeUpdateDraft(storage: Storage, profileId: string, campaignId: string, now = Date.now()) {
  const raw = storage.getItem(UPDATE_DRAFT_KEY);
  storage.removeItem(UPDATE_DRAFT_KEY);
  return parseUpdateDraft(raw, profileId, campaignId, now);
}
export function takeUpdateDraftWhenSafe(storage: Storage, profileId: string, campaignId: string, safe: boolean, now = Date.now()) {
  return safe ? takeUpdateDraft(storage, profileId, campaignId, now) : null;
}
