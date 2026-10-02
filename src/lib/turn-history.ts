type HistoryTurn = { id: string; turnNumber: number; role: string };

/** The snapshot wins on overlaps; player and narrator rows remain distinct. */
export function mergeHistoryTurns<T extends HistoryTurn>(older: T[], current: T[]): T[] {
  const rows = new Map<string, T>();
  for (const row of [...older, ...current]) rows.set(`${row.turnNumber}:${row.role}`, row);
  return [...rows.values()].sort((a, b) => a.turnNumber - b.turnNumber || (a.role === b.role ? 0 : a.role === "player" ? -1 : 1));
}

/** One shared request for manual paging and navigation. Strict cursor progress bounds work by history length. */
export function createTurnHistory<T extends HistoryTurn>({ current = [], fetchPage, onChange }: {
  current?: T[];
  fetchPage: (before: number, signal: AbortSignal) => Promise<T[]>;
  onChange: (older: T[]) => void;
}) {
  let older: T[] = [];
  let pending: Promise<boolean> | null = null;
  let exhausted = false;
  let generation = 0;
  let controller: AbortController | null = null;
  const turns = () => mergeHistoryTurns(older, current);
  const loadEarlier = (): Promise<boolean> => {
    if (pending) return pending;
    const before = Math.min(...turns().map(turn => turn.turnNumber));
    if (exhausted || !Number.isFinite(before) || before <= 1) return Promise.resolve(false);
    const started = generation;
    controller = new AbortController();
    pending = (async () => {
      const page = await fetchPage(before, controller!.signal);
      if (started !== generation) throw new Error("Переход отменён.");
      if (!page.length) { exhausted = true; return false; }
      const earlier = page.filter(turn => turn.turnNumber < before);
      if (!earlier.length) throw new Error("Не удалось продолжить загрузку истории. Попробуйте ещё раз.");
      older = mergeHistoryTurns(earlier, older);
      onChange(older);
      return true;
    })().finally(() => { if (started === generation) { pending = null; controller = null; } });
    return pending;
  };
  const ensureTurn = async (target: number): Promise<boolean> => {
    if (!Number.isSafeInteger(target) || target < 1) return false;
    const started = generation;
    while (started === generation) {
      const loaded = turns();
      if (loaded.some(turn => turn.turnNumber === target)) return true;
      if (Math.min(...loaded.map(turn => turn.turnNumber)) <= target || !(await loadEarlier())) return false;
    }
    throw new Error("Переход отменён.");
  };
  return { turns, loadEarlier, ensureTurn, setCurrent: (rows: T[]) => { current = rows; }, cancel: () => { generation++; controller?.abort(); pending = null; controller = null; } };
}
