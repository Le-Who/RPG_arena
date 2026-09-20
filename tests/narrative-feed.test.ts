import { test } from "node:test";
import assert from "node:assert/strict";
import * as feed from "../src/lib/narrative-feed";
import { withCommittedTurn } from "../src/lib/committed-turns";
import type { TurnResponse } from "../src/lib/turn-contract";

const pending = { sessionId: "session", expectedTurn: 3, action: "Открыть дверь" };
const result = { turnNumber: 4, requestId: "request", playerAction: pending.action, narration: "За дверью свет", choices: [], dice: null, modelUsed: "gemini", taskType: "narration" } as unknown as TurnResponse;

test("player is present before streaming starts and both rows retain identity through commit and DB refresh", () => {
  const initial = feed.buildNarrativeFeed([], pending, "");
  assert.deepEqual(initial.map(row => [row.role, row.content]), [["player", "Открыть дверь"]]);
  const streaming = feed.buildNarrativeFeed([], pending, "За дверью");
  const committed = withCommittedTurn([], result, "session");
  const published = feed.buildNarrativeFeed(committed, pending, "За дверью");
  const refreshed = feed.buildNarrativeFeed(committed.map((row, i) => ({ ...row, id: `db-uuid-${i}` })), null, "");
  assert.equal(streaming[0].key, initial[0].key);
  assert.deepEqual(streaming.map(row => row.role), ["player", "narrator"]);
  assert.deepEqual(published.map(row => row.key), streaming.map(row => row.key));
  assert.deepEqual(refreshed.map(row => row.key), streaming.map(row => row.key));
  assert.equal(published[1].content, "За дверью свет");
  assert.equal(published[1].pending, false);
  assert.equal(streaming[1].pending, true);
});

test("overlapping history pages deduplicate logical turns without collapsing different sessions", () => {
  const committed = withCommittedTurn([], result, "session");
  const otherSession = withCommittedTurn([], result, "other-session");
  const rows = feed.buildNarrativeFeed([...committed, ...committed.map(row => ({ ...row, id: `db-${row.id}` })), ...otherSession], null, "");
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map(row => row.key)).size, 4);
});

test("polling cannot move streamed progress backward or reopen a completed request", async () => {
  const { advanceTurnStage } = await import("../src/components/use-turn-request");
  assert.equal(advanceTurnStage("generation", "context"), "generation");
  assert.equal(advanceTurnStage("applying", "generation"), "applying");
  assert.equal(advanceTurnStage("generation", "applying"), "applying");
  assert.equal(advanceTurnStage("completed", "failed"), "completed");
  assert.equal(advanceTurnStage("generation", "failed"), "failed");
});
