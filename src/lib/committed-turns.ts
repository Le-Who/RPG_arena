import type { Snapshot } from "./ui-data";
import type { TurnResponse } from "./turn-contract";
export function applyCommittedSnapshot(snapshot: Snapshot | null, result: TurnResponse): Snapshot | null {
  if (!snapshot || !result.state || snapshot.session.turnCount > result.turnNumber) return snapshot;
  return { ...snapshot, session: { ...snapshot.session, ...result.state, turnCount: result.turnNumber, updatedAt: new Date() }, turns: withCommittedTurn(snapshot.turns, result, snapshot.session.id) };
}
/** These rows come only from a committed response, never a generation preview. */
export function withCommittedTurn(turns: Snapshot["turns"], result: TurnResponse | null, sessionId: string): Snapshot["turns"] {
  if (!result || turns.some(t => t.role === "narrator" && t.turnNumber === result.turnNumber)) return turns;
  const base = { sessionId, turnNumber: result.turnNumber, promptTokens: 0, completionTokens: 0, contextMeta: null, createdAt: new Date(), requestId: null, taskType: result.taskType };
  return [...turns,
    ...(result.playerAction && !turns.some(t => t.role === "player" && t.turnNumber === result.turnNumber) ? [{ ...base, id: `committed:${result.requestId}:player`, role: "player", content: result.playerAction, choices: [], dice: null, modelUsed: "player", stateChanges: null }] : []),
    { ...base, id: `committed:${result.requestId}:narrator`, role: "narrator", content: result.narration, choices: result.choices, dice: result.dice, modelUsed: result.modelUsed, stateChanges: result.applied },
  ];
}
