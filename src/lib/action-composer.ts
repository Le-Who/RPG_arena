import type { EntityKind, InteractionState } from "./interactions";

export const ACTION_MAX_LENGTH = 2000;
export type ActionEntitySuggestion = { kind: EntityKind; ref: string; name: string; start: number; end: number };

/** A phrase is added to the draft, never silently replacing or truncating it. */
export function appendActionPhrase(draft: string, phrase: string): string | null {
  const next = draft.trim() ? `${draft}${draft.endsWith("\n") ? "" : "\n"}${phrase}` : phrase;
  return next.length <= ACTION_MAX_LENGTH ? next : null;
}

const normalize = (value: string) => value.toLocaleLowerCase("ru").replace(/ё/g, "е");

// A narrow, explicit word family avoids fuzzy guesses about an item's identity.
const itemWord = (word: string) => /^трус(?:ы|ов|ам|ами|ах|ик(?:и|ов|ам|ами|ах)?)$/u.test(word) ? "трусы" : word;
const wordsOf = (value: string) => normalize(value).match(/[\p{L}\p{N}-]+/gu) ?? [];
const itemNameMatches = (name: string, query: string) => {
  const nameWords = wordsOf(name);
  return wordsOf(query).every(word => nameWords.some(candidate => candidate.startsWith(word) || itemWord(candidate) === itemWord(word)));
};

/** An explicit @ query searches inventory only; email-like text is not a mention. */
export function actionInventoryMention(text: string, caret: number): { query: string; start: number; end: number } | null {
  const match = text.slice(0, caret).match(/(?:^|[\s(«])@([\p{L}\p{N}-]*(?:[ \t]+[\p{L}\p{N}-]+)*[ \t]*)$/u);
  if (!match) return null;
  const query = match[1];
  let start = caret - query.length - 1;
  const remainingWord = text.slice(caret).match(/^[\p{L}\p{N}-]*/u)?.[0].length ?? 0;
  let end = caret + remainingWord;
  if (text[start - 1] === "«") start--;
  if (text[end] === "»") end++;
  return { query: query.trim(), start, end };
}

/** Match visible names and inventory words at the caret, without binding until selection. */
export function actionEntitySuggestions(text: string, caret: number, state: InteractionState): ActionEntitySuggestion[] {
  const mention = actionInventoryMention(text, caret);
  if (mention) return state.inventory
    .filter(item => item.quantity > 0 && itemNameMatches(item.name, mention.query))
    .slice(0, 6)
    .map(item => ({ kind: "item", ref: item.id, name: item.name, start: mention.start, end: mention.end }));

  const before = text.slice(0, caret);
  const fragment = before.match(/[\p{L}\p{N}-]+(?:[ \t]+[\p{L}\p{N}-]+)*$/u);
  if (!fragment || before[caret - fragment[0].length - 1] === "@") return [];
  const words = [...fragment[0].matchAll(/[\p{L}\p{N}-]+/gu)];
  let lazyEntities: Omit<ActionEntitySuggestion, "start" | "end">[] | null = null;
  const completeNames = new Set<string>();

  for (const word of words) {
    let start = caret - fragment[0].length + word.index!;
    const query = normalize(text.slice(start, caret));
    if (query.length < 2) continue;

    if (!lazyEntities) {
      lazyEntities = [
        ...state.inventory.filter(item => item.quantity > 0).map(item => ({ kind: "item" as const, ref: item.id, name: item.name })),
        ...state.npcs.map(npc => ({ kind: "npc" as const, ref: npc.key, name: npc.name })),
        ...state.locations.filter(location => location.discovered).map(location => ({ kind: "location" as const, ref: location.id, name: location.name })),
        ...state.sceneObjects.filter(object => normalize(object.locationName) === normalize(state.currentLocation)).map(object => ({ kind: "object" as const, ref: object.key, name: object.name })),
      ];
    }

    const matches = lazyEntities.filter(entity => {
      const name = normalize(entity.name);
      if (name === query) completeNames.add(name);
      return !completeNames.has(name) && (entity.kind === "item" ? itemNameMatches(entity.name, query) : name.startsWith(query));
    });
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
