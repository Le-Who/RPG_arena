import test from "node:test";
import assert from "node:assert/strict";
import { summarizeQueueHealth } from "../src/lib/queue-health";

test("empty queues report no age or failed jobs", () => {
  assert.deepEqual(summarizeQueueHealth([[], []], [null]), {
    observedJobs: 0, failedJobs: 0, failedRatio: 0, oldestPendingAt: null, oldestPendingAgeMs: null,
  });
});

test("queue snapshot includes both extraction and embedding backlogs using UTC database timestamps", () => {
  const snapshot = summarizeQueueHealth([
    [{ status: "failed", n: 2 }, { status: "ready", n: 6 }],
    [{ status: "pending", n: 2 }],
  ], ["2026-01-01T00:30:00Z", "2026-01-01 00:00:00"], Date.parse("2026-01-01T01:00:00Z"));
  assert.deepEqual(snapshot, { observedJobs: 10, failedJobs: 2, failedRatio: 0.2, oldestPendingAt: "2026-01-01T00:00:00.000Z", oldestPendingAgeMs: 3_600_000 });
});

test("invalid dates and future clock skew cannot produce negative queue ages", () => {
  assert.equal(summarizeQueueHealth([], ["invalid"]).oldestPendingAt, null);
  assert.equal(summarizeQueueHealth([], [new Date(500)], 100).oldestPendingAgeMs, 0);
});

test("timezone offsets are respected and invalid counts do not corrupt the snapshot", () => {
  const snapshot = summarizeQueueHealth([[{ status: "failed", n: -2 }, { status: "ready", n: NaN }, { status: "pending", n: 4 }]], ["2026-01-01T03:00:00+03:00"], Date.parse("2026-01-01T01:00:00Z"));
  assert.equal(snapshot.oldestPendingAgeMs, 3_600_000);
  assert.equal(snapshot.observedJobs, 4);
  assert.equal(snapshot.failedJobs, 0);
});
