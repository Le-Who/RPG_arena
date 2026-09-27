import assert from "node:assert/strict";
import test from "node:test";
import { createTurnHistory } from "../src/lib/turn-history";

const turn = (n: number, role = "narrator") => ({ id: `${n}-${role}`, turnNumber: n, role });

test("history joins concurrent paging and keeps each turn role once", async () => {
  let calls = 0;
  const history = createTurnHistory({ current: [turn(4)], onChange: () => {}, fetchPage: async () => {
    calls++; await new Promise(resolve => setTimeout(resolve, 10));
    return [turn(3, "player"), turn(3), turn(3), turn(4)];
  } });
  await Promise.all([history.loadEarlier(), history.loadEarlier(), history.ensureTurn(3)]);
  assert.equal(calls, 1);
  assert.deepEqual(history.turns().map(t => t.id), ["3-player", "3-narrator", "4-narrator"]);
});

test("history reaches a target beyond twenty pages without dropping progress", async () => {
  let calls = 0;
  const history = createTurnHistory({ current: [turn(24)], onChange: () => {}, fetchPage: async before => { calls++; return [turn(before - 1)]; } });
  assert.equal(await history.ensureTurn(1), true);
  assert.equal(calls, 23);
});

test("history reports missing targets and rejects pages without progress", async () => {
  const missing = createTurnHistory({ current: [turn(5)], onChange: () => {}, fetchPage: async () => [turn(1)] });
  assert.equal(await missing.ensureTurn(3), false);
  const stuck = createTurnHistory({ current: [turn(5)], onChange: () => {}, fetchPage: async () => [turn(5)] });
  await assert.rejects(stuck.ensureTurn(1), /продолжить загрузку/);
});

test("cancelled requests cannot publish stale history", async () => {
  let changes = 0;
  let finish!: (value: ReturnType<typeof turn>[]) => void;
  const history = createTurnHistory({ current: [turn(5)], onChange: () => { changes++; }, fetchPage: () => new Promise<ReturnType<typeof turn>[]>(resolve => { finish = resolve; }) });
  const pending = history.ensureTurn(1);
  history.cancel();
  finish([turn(1)]);
  await assert.rejects(pending, /отменён/);
  assert.equal(changes, 0);
});

 test("snapshot refresh updates current turns without discarding loaded history", async () => {
  const history = createTurnHistory({ current: [turn(3)], onChange: () => {}, fetchPage: async () => [turn(2)] });
  await history.loadEarlier();
  history.setCurrent([turn(3), turn(4)]);
  assert.equal(await history.ensureTurn(4), true);
  assert.deepEqual(history.turns().map(row => row.turnNumber), [2, 3, 4]);
});
