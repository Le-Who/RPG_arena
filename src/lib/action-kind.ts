/** UI classification for a NEW request. Never reclassify a stored pending turn. */
export function classifyAction(text: string, choices: readonly string[]) {
  const action = text.trim();
  const choice = action ? choices.findIndex(value => value.trim() === action) : -1;
  return { action, custom: choice < 0, choice };
}
