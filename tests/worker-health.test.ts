import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { summarizeWorkerHealth, workerHeartbeatKey } from "../src/lib/worker-health";

const now = Date.parse("2026-09-23T12:00:00Z");
const beat = (id: string, status: string, age: number) => ({ id, status, lastSeenAt: new Date(now - age) });

test("worker processes have distinct stable heartbeat keys, separate from owner-scoped request ticks", () => {
  assert.equal(workerHeartbeatKey("worker", undefined, "instance-a"), "memory:worker:instance-a");
  assert.notEqual(workerHeartbeatKey("worker", undefined, "instance-a"), workerHeartbeatKey("worker", undefined, "instance-b"));
  assert.equal(workerHeartbeatKey("worker"), workerHeartbeatKey("worker"));
  assert.notEqual(workerHeartbeatKey("worker"), "memory:worker");
  assert.equal(workerHeartbeatKey("manual", "owner-a"), "memory:manual:owner-a");
  assert.equal(workerHeartbeatKey("after", "owner-b"), "memory:after:owner-b");
});

test("separate Node processes generate independent default worker identities", async () => {
  const args = ["--import", "tsx", "--eval", "const {workerHeartbeatKey}=require('./src/lib/worker-health');console.log(JSON.stringify([workerHeartbeatKey('worker'),workerHeartbeatKey('worker')]))"];
  const results = await Promise.all([promisify(execFile)(process.execPath, args), promisify(execFile)(process.execPath, args)]);
  const [first, second] = results.map(result => JSON.parse(result.stdout) as string[]);
  assert.equal(first[0], first[1]);
  assert.equal(second[0], second[1]);
  assert.notEqual(first[0], second[0]);
});

test("stopping one worker does not mark another live instance stopped", () => {
  const health = summarizeWorkerHealth([beat("memory:worker:a", "stopped", 0), beat("memory:worker:b", "idle", 1000)], now);
  assert.equal(health.online, true);
  assert.equal(health.onlineInstances, 1);
  assert.equal(health.status, "idle");
  assert.equal(health.heartbeatAgeMs, 1000);
  assert.equal(health.instances.find(row => row.id === "memory:worker:a")?.online, false);
});

test("legacy and new heartbeat rows coexist without making stopped or stale processes online", () => {
  const health = summarizeWorkerHealth([beat("memory:worker", "stopped", 10), beat("memory:worker:a", "running", 120_000)], now);
  assert.equal(health.online, false);
  assert.equal(health.onlineInstances, 0);
  assert.equal(health.status, "stopped");
  assert.equal(health.report, null);
});

test("worker health reports absent instances and clamps future clock skew", () => {
  const empty = summarizeWorkerHealth([], now);
  assert.equal(empty.status, "not-started");
  assert.equal(empty.lastSeenAt, null);
  assert.equal(empty.heartbeatAgeMs, null);
  const future = summarizeWorkerHealth([beat("memory:worker:a", "running", -1000)], now);
  assert.equal(future.heartbeatAgeMs, 0);
});
