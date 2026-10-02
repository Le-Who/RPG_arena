/** UX-2b: «ход 12», «#12», «turn 12» → номер хода; всё остальное — обычный поиск палитры. */
export function parseTurnQuery(query: string): number | null {
  const match = query.trim().toLocaleLowerCase("ru").match(/^(?:ход|turn|#)\s*(\d{1,6})$/);
  const turn = match ? Number(match[1]) : NaN;
  return Number.isInteger(turn) && turn >= 1 ? turn : null;
}
