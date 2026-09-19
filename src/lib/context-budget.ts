export type ContextItem = { id: string; name: string; kind: string; quantity: number; equipped: boolean; description: string; power?: number };
/** Lexical matching is only for selecting existing owned items, never for inventing canonical facts. */
export function relevantInventory<T extends ContextItem>(items: T[], action: string, limit = 14): T[] {
  const text = action.toLocaleLowerCase("ru");
  const referenced = (item: T) => {
    const name = item.name.toLocaleLowerCase("ru").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.includes(item.id.toLowerCase()) || new RegExp(`#${item.id.slice(0, 6)}(?![0-9a-f])`, "i").test(text) || (item.name.length >= 3 && new RegExp(`(^|[^\\p{L}\\p{N}_])${name}($|[^\\p{L}\\p{N}_])`, "u").test(text));
  };
  const score = (item: T) => Number(referenced(item)) * 100 + Number(item.kind === "quest") * 10 + Number(item.equipped) * 5;
  return items.filter((item) => item.quantity > 0).map((item, index) => ({ item, index, score: score(item) })).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, Math.max(1, Math.min(limit, 30))).map((row) => row.item);
}
