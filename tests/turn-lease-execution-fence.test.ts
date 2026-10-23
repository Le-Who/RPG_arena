import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { accountsDb } from "./helpers/accounts-db";
import { acquireTurn, assertTurnLease, completeTurnRequest, normalizeTurnInput, setTurnStage } from "../src/lib/turn-admission";
import type { TurnResponse } from "../src/lib/turn-contract";

const result: TurnResponse = { ok: true, turnNumber: 2, narration: "Ты осмотрел площадь.", choices: ["Подождать"], dice: null, outcome: "neutral", modelUsed: "fixture", taskType: "resolution", needsCompaction: false,
  dead: false, retrieved: [], skippedModels: [], warnings: [], applied: { hp: 0, xp: 0, gold: 0, danger: 0, dead: false, levelUp: false, location: null, npcs: [], quests: [], inventory: [], sceneObjects: [], conditions: { added: [], removed: [] }, rejected: [] } };

test("turn authority checks expiry when queued SQL executes, preserving atomic rollback and replay", async t => {
  const fixture = await accountsDb();
  const { db, pool } = await import("../src/db");
  const admit = async () => {
    const sessionId = randomUUID();
    await fixture.pg.query("INSERT INTO game_sessions(id,title,rules_profile,character,world_state,turn_count) VALUES ($1,'Lease fixture','narrative',$2,$3,1)", [sessionId,
      JSON.stringify({ name: "Ада", archetype: "Путник", level: 1, xp: 0, hp: 20, maxHp: 20, gold: 0, stats: {}, skills: [], traits: [], conditions: [], backstory: "", appearance: "" }),
      JSON.stringify({ worldName: "Город", tone: "спокойный", era: "сейчас", mainQuest: "", currentLocation: "Площадь", factions: [], flags: {}, danger: 0, chapter: 1 })]);
    const input = normalizeTurnInput({ sessionId, action: "Осмотреться", isFree: true, requestId: randomUUID(), expectedTurn: 1 });
    const admitted = await acquireTurn(input);
    assert.equal(admitted.kind, "lease");
    if (admitted.kind !== "lease") throw new Error("Expected a fresh lease");
    return { input, lease: admitted.lease };
  };
  try {
    for (const operation of ["stage", "assert", "complete"] as const) await t.test(`${operation} rejects a lease that expires after SQL construction`, async () => {
      const { lease } = await admit();
      let gated = false;
      const run = async (...args: Parameters<typeof fixture.run>) => {
        const config = typeof args[0] === "string" ? { text: args[0], values: args[1] } : args[0];
        if (!gated && config.text.includes('"turn_requests"')) {
          gated = true;
          // The legacy predicate binds its client timestamp before entering
          // this query gate. Expire immediately after that bound instant, but
          // before execution, without depending on an arbitrary sleep.
          const timestamps = (config.values ?? []).filter((value): value is string => typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value));
          const constructedAt = timestamps.at(-1) ?? new Date().toISOString();
          await fixture.pg.query("UPDATE turn_requests SET lease_expires_at=$2::timestamp + interval '1 microsecond' WHERE id=$1", [lease.id, constructedAt]);
          // PGlite can execute both statements within one clock tick. Wait for
          // the actual SQL precondition, retaining expiry after the legacy bound.
          let expired = false;
          const deadline = performance.now() + 2000;
          do {
            [{ expired }] = (await fixture.pg.query<{ expired: boolean }>("SELECT lease_expires_at <= (clock_timestamp() AT TIME ZONE 'UTC') AS expired FROM turn_requests WHERE id=$1", [lease.id])).rows;
            if (!expired) await new Promise<void>(resolve => setImmediate(resolve));
          } while (!expired && performance.now() < deadline);
          assert.equal(expired, true, "the query gate must establish expiry before authority SQL executes");
        }
        return fixture.run(...args);
      };
      const query = mock.method(pool, "query", run as never);
      const connect = mock.method(pool, "connect", async () => ({ query: run, release() {} }));
      try {
        const work = operation === "stage" ? setTurnStage(lease, "generation") : db.transaction(async tx => {
          if (operation === "assert") return assertTurnLease(tx, lease);
          await tx.execute(sql`UPDATE game_sessions SET turn_count=2 WHERE id=${lease.sessionId}`);
          return completeTurnRequest(tx, lease, result);
        });
        await assert.rejects(work, error => error instanceof Error && "code" in error && error.code === "LEASE_EXPIRED");
        assert.equal(gated, true);
        assert.deepEqual((await fixture.pg.query("SELECT status,stage,result FROM turn_requests WHERE id=$1", [lease.id])).rows, [{ status: "running", stage: "context", result: null }]);
        assert.equal((await fixture.pg.query<{ turn_count: number }>("SELECT turn_count FROM game_sessions WHERE id=$1", [lease.sessionId])).rows[0].turn_count, 1);
      } finally { query.mock.restore(); connect.mock.restore(); }
    });
    for (const zone of ["Europe/Kyiv", "America/New_York"]) {
      for (const fresh of [true, false]) await t.test(`${zone}: ${fresh ? "fresh" : "expired"} UTC lease uses the same authority in every connection timezone`, async () => {
        await fixture.pg.exec(`SET TIME ZONE '${zone}'`);
        try {
          const { lease } = await admit();
          await fixture.pg.query("UPDATE turn_requests SET lease_expires_at=$2 WHERE id=$1", [lease.id, new Date(Date.now() + (fresh ? 30_000 : -30_000))]);
          const stage = () => setTurnStage(lease, "generation");
          const validate = () => db.transaction(tx => assertTurnLease(tx, lease));
          const complete = () => db.transaction(tx => completeTurnRequest(tx, lease, result));
          for (const operation of [stage, validate, complete]) {
            if (fresh) await operation();
            else await assert.rejects(operation(), error => error instanceof Error && "code" in error && error.code === "LEASE_EXPIRED");
          }
          assert.equal((await fixture.pg.query<{ status: string }>("SELECT status FROM turn_requests WHERE id=$1", [lease.id])).rows[0].status, fresh ? "completed" : "running");
        } finally { await fixture.pg.exec("SET TIME ZONE 'UTC'"); }
      });
    }
    await t.test("a fresh lease stages, validates and completes once, then replays its result", async () => {
      const { lease, input } = await admit();
      await setTurnStage(lease, "generation");
      await db.transaction(async tx => { await assertTurnLease(tx, lease); await completeTurnRequest(tx, lease, result); });
      const replay = await acquireTurn(input);
      assert.equal(replay.kind, "replay");
      if (replay.kind === "replay") assert.deepEqual(replay.result, { ...result, requestId: lease.requestId, replay: true });
    });
  } finally { await fixture.close(); }
});
