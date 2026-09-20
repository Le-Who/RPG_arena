import type { Snapshot } from "./ui-data";

type FeedTurn = Pick<Snapshot["turns"][number], "sessionId" | "turnNumber" | "role" | "content" | "modelUsed" | "dice" | "stateChanges">;
export type NarrativeFeedRow = FeedTurn & { key: string; pending: boolean };
type PendingFeedTurn = { sessionId: string; expectedTurn: number; action: string };

/** Identity belongs to the story position, not a temporary or database row ID. */
export function buildNarrativeFeed(turns: FeedTurn[], pending: PendingFeedTurn | null, preview: string): NarrativeFeedRow[] {
  const rows = new Map<string, NarrativeFeedRow>();
  const add = (turn: FeedTurn, isPending: boolean) => {
    const key = JSON.stringify([turn.sessionId, turn.turnNumber, turn.role]);
    if (!rows.has(key)) rows.set(key, { ...turn, key, pending: isPending });
  };
  for (const turn of turns) add(turn, false);
  if (pending) {
    const base = { sessionId: pending.sessionId, turnNumber: pending.expectedTurn + 1, modelUsed: null, dice: null, stateChanges: null };
    add({ ...base, role: "player", content: pending.action }, true);
    if (preview) add({ ...base, role: "narrator", content: preview }, true);
  }
  return [...rows.values()].sort((a, b) => a.turnNumber - b.turnNumber || (a.role === "player" ? 0 : 1) - (b.role === "player" ? 0 : 1));
}
