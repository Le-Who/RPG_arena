import type { EntityKind, InteractionState } from "./interactions";

export const ACTION_MAX_LENGTH = 2000;
export type ActionEntitySuggestion = { kind: EntityKind; ref: string; name: string; start: number; end: number };

/** A phrase is added to the draft, never silently replacing or truncating it. */
export function appendActionPhrase(draft: string, phrase: string): string | null {
  const next = draft.trim() ? `${draft}${draft.endsWith("\n") ? "" : "\n"}${phrase}` : phrase;
  return next.length <= ACTION_MAX_LENGTH ? next : null;
}

const normalize = (value: string) => value.toLocaleLowerCase("ru").replace(/ё/g, "е");

/** Match name prefixes at the caret using only entities already visible in the snapshot. */
export function actionEntitySuggestions(text: string, caret: number, state: InteractionState): ActionEntitySuggestion[] {
  const before = text.slice(0, caret);
  const fragment = before.match(/[\p{L}\p{N}-]+(?:[ \t]+[\p{L}\p{N}-]+)*$/u);
  if (!fragment) return [];
  const entities = [
    ...state.inventory.filter(item => item.quantity > 0).map(item => ({ kind: "item" as const, ref: item.id, name: item.name })),
    ...state.npcs.map(npc => ({ kind: "npc" as const, ref: npc.key, name: npc.name })),
    ...state.locations.filter(location => location.discovered).map(location => ({ kind: "location" as const, ref: location.id, name: location.name })),
    ...state.sceneObjects.filter(object => normalize(object.locationName) === normalize(state.currentLocation)).map(object => ({ kind: "object" as const, ref: object.key, name: object.name })),
  ];
  const words = [...fragment[0].matchAll(/[\p{L}\p{N}-]+/gu)];
  for (const word of words) {
    let start = caret - fragment[0].length + word.index!;
    const query = normalize(text.slice(start, caret));
    if (query.length < 2) continue;
    const matches = entities.filter(entity => normalize(entity.name).startsWith(query) && normalize(entity.name) !== query);
    if (!matches.length) continue;
    if (text[start - 1] === "«") start--;
    const remainingWord = text.slice(caret).match(/^[\p{L}\p{N}-]*/u)?.[0].length ?? 0;
    let end = caret + remainingWord;
    if (text[end] === "»") end++;
    return matches.slice(0, 6).map(entity => ({ ...entity, start, end }));
  }
  return [];
}

export function completeActionEntity(text: string, entity: ActionEntitySuggestion): { text: string; caret: number } | null {
  const name = `«${entity.name}»`;
  const next = text.slice(0, entity.start) + name + text.slice(entity.end);
  return next.length <= ACTION_MAX_LENGTH ? { text: next, caret: entity.start + name.length } : null;
}
