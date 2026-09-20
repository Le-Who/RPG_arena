import { HttpError, requireUuid } from "./http";
export type ItemBinding = { id: string; name: string };
export function normalizeItemIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4 || value.some(id => typeof id !== "string")) throw new HttpError(400, "INVALID_INPUT", "Некорректная привязка предмета.");
  return [...new Set(value.map(id => requireUuid(id).toLowerCase()))].sort();
}
export function retainedItemBindings(action: string, bindings: ItemBinding[]): ItemBinding[] {
  return bindings.filter(item => action.includes(`«${item.name}»`));
}
/** Only the model sees exact identities; the journal retains the player's original prose. */
export function actionWithItemBindings(action: string, ids: string[] = [], inventory: (ItemBinding & { quantity: number })[]): string {
  const selected = ids.map(id => {
    const item = inventory.find(i => i.id === id && i.quantity > 0);
    if (!item) throw new HttpError(409, "INVALID_INPUT", "Выбранный предмет больше недоступен. Обновите инвентарь.");
    return item;
  });
  return selected.length ? `${action}\n[Служебная привязка выбранных предметов: ${selected.map(i => `${i.name}: #${i.id}`).join("; ")}. Используй эти ref для выбранных предметов. Никогда не включай ID в narration или choices.]` : action;
}
