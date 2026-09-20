import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgreementProposals, reduceAgreementProposals, loadAgreementHistory, appendAgreementRevisions, type AgreementProposal } from "../src/lib/narrative-agreements";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";

const sessionId = "00000000-0000-4000-8000-000000000001";
const originTurnId = "00000000-0000-4000-8000-000000000010";
const proposal: AgreementProposal = { parties: ["player", "merchant"], object: "silver key", consideration: "ten coins", conditions: ["at dawn"], status: "proposed" };
const reduce = (proposals: AgreementProposal[], history: ReturnType<typeof reduceAgreementProposals>["accepted"] = [], turnNumber = 1) => reduceAgreementProposals({ sessionId, turnNumber, originTurnId, proposals, history, playerAction: "I offer ten coins.", currentNarration: "The merchant considers the offer." });

test("proposal parser bounds payloads and preserves rejected evidence instead of silently accepting malformed terms", () => {
  const result = parseAgreementProposals([proposal, { ...proposal, object: "" }, { ...proposal, parties: ["player"] }, proposal]);
  assert.equal(result.proposals.length, 1);
  assert.equal(result.rejected.length, 3);
  assert.equal(parseAgreementProposals(undefined).rejected.length, 0);
  assert.equal(parseAgreementProposals({}).rejected.length, 1);
});

test("player intention cannot accept or fulfill a contract and new fulfilled history cannot be invented", () => {
  assert.equal(reduce([{ ...proposal, status: "accepted", source: { kind: "player_intent" } }]).accepted.length, 0);
  assert.equal(reduce([{ ...proposal, status: "fulfilled" }]).accepted.length, 0);
  const revision = reduce([proposal]).accepted[0];
  assert.equal(revision.status, "proposed");
  assert.match(revision.id, /^[0-9a-f-]{36}$/);
  assert.match(revision.agreementId, /^[0-9a-f-]{36}$/);
  assert.equal(revision.version, 1);
});

test("revisions preserve original object and reject unknown foreign stale and future references", () => {
  const first = reduce([proposal]).accepted[0];
  const amendment = { ...proposal, agreementId: first.agreementId, previousRevisionId: first.id, status: "accepted" as const };
  const second = reduce([amendment], [first], 2).accepted[0];
  assert.equal(second.version, 2);
  assert.equal(second.previousRevisionId, first.id);
  assert.equal(first.status, "proposed");
  assert.equal(reduce([amendment], [first, second], 3).accepted.length, 0);
  assert.equal(reduce([amendment], [], 2).accepted.length, 0);
  assert.equal(reduce([amendment], [{ ...first, sessionId: originTurnId }], 2).accepted.length, 0);
  assert.equal(reduce([amendment], [first], 1).accepted.length, 0);
  const fulfilled = reduce([{ ...amendment, previousRevisionId: second.id, status: "fulfilled" }], [first, second], 3).accepted[0];
  assert.equal(fulfilled.status, "fulfilled");
  assert.equal(reduce([{ ...amendment, previousRevisionId: fulfilled.id }], [first, second, fulfilled], 4).accepted.length, 0);
});

test("journal enforces append-only session scoped history, final source binding, chain integrity and atomic rollback", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE TABLE game_sessions (id uuid PRIMARY KEY); CREATE TABLE game_turns (id uuid PRIMARY KEY, session_id uuid, turn_number integer, role text, content text);
      INSERT INTO game_sessions VALUES ('${sessionId}'), ('${originTurnId}');
      INSERT INTO game_turns VALUES ('${originTurnId}', '${sessionId}', 1, 'narrator', 'The merchant considers the offer.');`);
    await pg.exec(await readFile(new URL("../drizzle/0008_agreement_events.sql", import.meta.url), "utf8"));
    const local = drizzle(pg);
    const first = reduce([proposal]).accepted[0];
    const saved = await local.transaction(tx => appendAgreementRevisions(tx, [first], { narration: "The merchant considers the offer.", narratorTurnId: originTurnId }));
    assert.equal(saved[0].source.quote, "The merchant considers the offer.");
    assert.equal(saved[0].source.textSha256.length, 64);
    assert.equal((await loadAgreementHistory(local, sessionId, 2))[0].id, first.id);
    assert.deepEqual(await loadAgreementHistory(local, sessionId, 1), []);
    assert.deepEqual(await loadAgreementHistory(local, originTurnId, 2), []);
    await assert.rejects(pg.query("UPDATE agreement_events SET object = 'golden crown' WHERE id = $1", [first.id]), /IMMUTABLE/);
    await assert.rejects(pg.query("DELETE FROM agreement_events WHERE id = $1", [first.id]), /IMMUTABLE/);
    const second = reduce([{ ...proposal, agreementId: first.agreementId, previousRevisionId: first.id, status: "accepted" }], [first], 2).accepted[0];
    const finalSource = { narration: "The merchant accepts the silver key exchange.", narratorTurnId: "00000000-0000-4000-8000-000000000011" };
    await assert.rejects(local.transaction(async tx => {
      await tx.execute(sql`INSERT INTO game_turns VALUES (${finalSource.narratorTurnId},${sessionId},2,'narrator',${finalSource.narration})`);
      await appendAgreementRevisions(tx, [second], finalSource);
      throw new Error("ROLLBACK_TEST");
    }), /ROLLBACK_TEST/);
    assert.equal((await loadAgreementHistory(local, sessionId, 3)).length, 1);
    await pg.query("INSERT INTO game_turns VALUES ($1,$2,2,'narrator',$3)", [finalSource.narratorTurnId, sessionId, finalSource.narration]);
    await assert.rejects(local.transaction(tx => appendAgreementRevisions(tx, [{ ...second, previousRevisionId: originTurnId }], finalSource)),
      (error: unknown) => (error as { cause?: Error }).cause?.message === "INVALID_AGREEMENT_REVISION");
    await local.transaction(tx => appendAgreementRevisions(tx, [second], finalSource));
    assert.deepEqual((await loadAgreementHistory(local, sessionId, 3)).map(r => r.status), ["proposed", "accepted"]);
    await assert.rejects(pg.query(`INSERT INTO agreement_events SELECT gen_random_uuid(), gen_random_uuid(), session_id, turn_number, 1, NULL,
      parties, object, consideration, conditions, 'proposed', rules_version,
      jsonb_set(source, '{textSha256}', to_jsonb(repeat('a',64))), created_at FROM agreement_events WHERE id=$1`, [first.id]), /INVALID_AGREEMENT_SOURCE/);
    await pg.query(`INSERT INTO agreement_events SELECT gen_random_uuid(), gen_random_uuid(), session_id, turn_number, 1, NULL,
      parties, object, consideration, conditions, 'proposed', rules_version, source, created_at
      FROM agreement_events CROSS JOIN generate_series(1,999) WHERE id=$1`, [first.id]);
    await assert.rejects(loadAgreementHistory(local, sessionId, 3), /AGREEMENT_HISTORY_LIMIT/);
    await pg.query("DELETE FROM game_sessions WHERE id=$1", [sessionId]);
    assert.deepEqual(await loadAgreementHistory(local, sessionId, 3), []);
  } finally { await pg.close(); }
});
