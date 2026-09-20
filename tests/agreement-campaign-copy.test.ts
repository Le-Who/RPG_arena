import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { assertSnapshot, remapSnapshot } from "../src/lib/checkpoint-snapshot";
import type { CheckpointSnapshot } from "../src/lib/checkpoint-types";
import { appendAgreementRevisions, loadAgreementHistory, reduceAgreementProposals } from "../src/lib/narrative-agreements";

process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/agreement_copy_test";

test("checkpoint forks and public personal copies preserve immutable agreement chains with isolated identities", async () => {
  const { db, pool } = await import("../src/db");
  const { createCheckpoint, forkCheckpoint } = await import("../src/lib/checkpoints");
  const { copyCampaign } = await import("../src/lib/campaign-copy");
  const { exportCampaignMarkdown } = await import("../src/lib/campaign-export");
  const pg = new PGlite({ extensions: { vector, pgcrypto } });
  for (const file of (await readdir("drizzle")).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort()) await pg.exec(await readFile(`drizzle/${file}`, "utf8"));
  const run = async (query: string | { text: string; values?: unknown[]; rowMode?: string }, values?: unknown[]) => {
    const config = typeof query === "string" ? { text: query, values } : { ...query, values: values ?? query.values };
    const result = await pg.query<Record<string, unknown>>(config.text, config.values);
    const normalize = (v: unknown) => v instanceof Date ? v.toISOString() : v;
    return { ...result, rows: result.rows.map(row => config.rowMode === "array" ? result.fields.map(f => normalize(row[f.name])) : Object.fromEntries(Object.entries(row).map(([k, v]) => [k, normalize(v)]))) };
  };
  const queryMock = mock.method(pool, "query", run as never);
  const connectMock = mock.method(pool, "connect", async () => ({ query: run, release() {} }) as never);
  try {
    const sessionId = randomUUID(), narratorIds: string[] = [randomUUID(), randomUUID()];
    const world = { worldName: "Harbor", tone: "Adventure", era: "Now", mainQuest: "Trade", currentLocation: "Market", factions: [], flags: {}, danger: 0, chapter: 1 };
    const character = { name: "Ada", archetype: "Trader", level: 1, xp: 0, hp: 10, maxHp: 10, gold: 5, stats: {}, skills: [], traits: [], conditions: [] };
    await pg.query("INSERT INTO game_sessions (id,title,character,world_state,turn_count,owner_id,visibility) VALUES ($1,'Agreement world',$2,$3,2,'owner','public')", [sessionId, JSON.stringify(character), JSON.stringify(world)]);
    await pg.query("INSERT INTO world_locations (session_id,name,current) VALUES ($1,'Market',true)", [sessionId]);
    const narration = [`Ada offers a silver key. Record ${narratorIds[0]}.`, "The merchant accepts the silver key in return for safe passage."];
    const terms = { parties: ["Ada", "merchant"], object: "silver key", consideration: "safe passage", conditions: ["before dawn"], status: "proposed" as const };
    let history: Awaited<ReturnType<typeof loadAgreementHistory>> = [];
    for (let i = 0; i < 2; i++) {
      await pg.query("INSERT INTO game_turns (id,session_id,turn_number,role,content) VALUES ($1,$2,$3,'narrator',$4)", [narratorIds[i], sessionId, i + 1, narration[i]]);
      const proposals = i === 0 ? [terms] : [{ ...terms, status: "accepted" as const, agreementId: history[0].agreementId, previousRevisionId: history[0].id }];
      const planned = reduceAgreementProposals({ sessionId, turnNumber: i + 1, originTurnId: narratorIds[i], history, proposals, currentNarration: narration[i], playerAction: "Trade" });
      history.push(...await db.transaction(tx => appendAgreementRevisions(tx, planned.accepted, { narratorTurnId: narratorIds[i], narration: narration[i] })));
    }
    const checkpoint = await createCheckpoint({ sessionId, title: "After trade", expectedTurn: 2, requestId: randomUUID() });
    const snapshot = (await pg.query<{ snapshot: CheckpointSnapshot }>("SELECT snapshot FROM campaign_checkpoints WHERE id=$1", [checkpoint.checkpoint.id])).rows[0].snapshot;
    assert.equal(snapshot.agreements?.length, 2, "new snapshots must include immutable agreement history");
    const original = JSON.stringify(snapshot);
    const forkInput = { sessionId, checkpointId: checkpoint.checkpoint.id, requestId: randomUUID(), title: "Alternative" };
    const fork = await forkCheckpoint(forkInput);
    const copyInput = { sessionId, profileId: "reader", requestId: randomUUID() };
    const copy = await copyCampaign(copyInput);
    for (const branch of [fork.session, copy.session]) {
      const revisions = await loadAgreementHistory(db, branch.id, 3);
      assert.deepEqual(revisions.map(r => r.status), ["proposed", "accepted"]);
      assert.deepEqual(revisions.map(r => r.object), ["silver key", "silver key"]);
      assert.notEqual(revisions[0].agreementId, history[0].agreementId);
      assert.notEqual(revisions[0].id, history[0].id);
      assert.equal(revisions[1].agreementId, revisions[0].agreementId);
      assert.equal(revisions[1].previousRevisionId, revisions[0].id);
      assert.ok(revisions.every(r => r.sessionId === branch.id));
      assert.deepEqual(revisions.map(r => r.source.quote), narration);
      assert.deepEqual(revisions.map(r => r.source.textSha256), history.map(r => r.source.textSha256));
      assert.ok(revisions.every(r => !narratorIds.includes(r.source.originTurnId)));
    }
    assert.equal((await forkCheckpoint(forkInput)).replay, true);
    assert.equal((await copyCampaign(copyInput)).replay, true);
    assert.equal((await loadAgreementHistory(db, sessionId, 3)).length, 2);
    const exported = await exportCampaignMarkdown(sessionId);
    assert.ok(exported?.includes('"object": "silver key"'));
    assert.ok(exported?.includes(history[1].id));
    assert.ok(exported?.includes(history[0].source.textSha256));
    assert.ok(!exported?.includes(copy.session.id));
    assert.equal(await exportCampaignMarkdown(randomUUID()), null);
    assert.equal(JSON.stringify(snapshot), original);
    const old = structuredClone(snapshot); delete old.agreements;
    assertSnapshot(remapSnapshot(old));
    for (const mutate of [
      (s: CheckpointSnapshot) => { s.agreements![0].source.textSha256 = "a".repeat(64); },
      (s: CheckpointSnapshot) => { s.agreements![0].sessionId = randomUUID(); },
      (s: CheckpointSnapshot) => { s.agreements![1].previousRevisionId = randomUUID(); },
      (s: CheckpointSnapshot) => { s.agreements![0].source.originTurnId = randomUUID(); },
      (s: CheckpointSnapshot) => { s.agreements![0].object = ""; },
    ]) {
      const corrupt = structuredClone(snapshot); mutate(corrupt);
      assert.throws(() => assertSnapshot(corrupt), /сним|Сним|договор/i);
    }
  } finally { queryMock.mock.restore(); connectMock.mock.restore(); await pg.close(); }
});
