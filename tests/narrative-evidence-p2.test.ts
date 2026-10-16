import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { appendAgreementRevisions, loadAgreementHistory, reduceAgreementProposals, type AgreementProposal } from "../src/lib/narrative-agreements";
import { buildNarrativeEvidenceQuery, snapshotNarrativeEvidence } from "../src/lib/narrative-evidence";
import { guardNarrative } from "../src/lib/narrative-guard";
import { selectNarrativeChecks } from "../src/lib/narrative-policy";
import { parseNarrativeReview } from "../src/lib/narrative-review";
import { narrativeJevTask, verifyNarrative, type NarrativeVerification } from "../src/lib/narrative-verifier";
import { recordingJevTransport, replayJevTransport, runJevTask, type JevRecording, type JevTransport } from "../src/lib/jev-tasks";

const sessionId = "00000000-0000-4000-8000-000000000001";
const narratorTurnId = "00000000-0000-4000-8000-000000000010";
const sourceText = "Мира согласилась вернуть амулет в обмен на серебряный ключ.";
const proposal: AgreementProposal = { parties: ["Герой", "Мира"], object: "серебряный ключ", consideration: "вернуть амулет", conditions: [], status: "accepted" };
const reduce = (p: AgreementProposal) => reduceAgreementProposals({ sessionId, turnNumber: 2, currentNarration: sourceText,
  playerAction: "Предложить договор", history: [], proposals: [p] });
const guardInput = () => ({ action: "Напомнить договор", narration: sourceText, choices: [], declaration: { mode: "event", referencesPast: true },
  hasDice: false, hasStateChanges: true, rejected: [], emittedPrefix: "", remainingMs: () => 20000,
  state: { currentTurn: 2, accepted_changes: { agreements: [] }, historical_evidence: { sources: [], agreements: [] } } });
const responseFor = (questions: Record<string, unknown>) => ({ model: "jev-1.13.0", usage: { input_tokens: 20, output_tokens: 0 },
  answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: "choice", choice: "consistent", confidence: .99,
    probabilities: { consistent: .98, contradicts: .01, insufficient: .01 } }])) });

test("guard rejects malformed resolved verifier envelopes without repair or escaped exceptions", async t => {
  for (const [name, report] of [["null", null], ["undefined", undefined], ["primitive", 42], ["missing status", {}],
    ["null answers", { status: "verified", answers: null }], ["array answers", { status: "verified", answers: [] }], ["unknown status", { status: "approved", answers: {} }]] as const) {
    await t.test(name, async () => {
      let repairs = 0;
      const result = await guardNarrative({ ...guardInput(), verify: async () => report as unknown as NarrativeVerification,
        repair: async () => { repairs++; return null; } });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, "verification_failed");
      assert.equal(repairs, 0);
    });
  }
});

test("agreement quote offsets must remain inside their current narration or player action", () => {
  const invalidNarration = reduce({ ...proposal, source: { kind: "current_turn", quote: sourceText, start: 0, end: sourceText.length + 1 } });
  assert.deepEqual(invalidNarration.accepted, []);
  assert.deepEqual(invalidNarration.rejected, [{ index: 0, reason: "AGREEMENT_SOURCE_MISMATCH" }]);
  const invalidIntent = reduce({ ...proposal, status: "proposed", source: { kind: "player_intent", quote: "Предложить договор", start: 0, end: 1000 } });
  assert.deepEqual(invalidIntent.accepted, []);
  assert.deepEqual(invalidIntent.rejected, [{ index: 0, reason: "AGREEMENT_SOURCE_MISMATCH" }]);
  assert.equal(reduce({ ...proposal, source: { kind: "current_turn", quote: sourceText, start: 0, end: sourceText.length } }).accepted.length, 1);
});

test("edited terms remain provisional and a real adapter rejection stops the guard despite the same source sentence", async () => {
  const candidate = reduce({ ...proposal, object: "весь район" }).accepted[0];
  assert.equal(candidate.object, "весь район");
  assert.equal(candidate.source.quote, "");
  const original = { turn: 1, role: "narrator", authority: "verified_narration", text: sourceText,
    sha256: createHash("sha256").update(sourceText).digest("hex") };
  const accepted_changes = { agreements: [candidate] };
  const state = { currentTurn: 2, accepted_changes, historical_evidence: { sources: [original], agreements: [] } };
  const before = structuredClone(state);
  let calls = 0, repairs = 0;
  const result = await guardNarrative({ ...guardInput(), state,
    verify: async (snapshot, selection) => verifyNarrative({ state: snapshot, selection, apiKey: "fixture-key", transport: async ({ body }) => {
      calls++;
      const outgoing = JSON.parse(body);
      assert.equal(outgoing.state.accepted_changes.agreements[0].object, "весь район");
      assert.equal(outgoing.state.historical_evidence.sources[0].text, sourceText);
      assert.ok(outgoing.questions.agreements);
      assert.ok(outgoing.questions.history_object);
      const response = responseFor(outgoing.questions);
      response.answers.agreements = { type: "choice", choice: "contradicts", confidence: .99,
        probabilities: { consistent: .01, contradicts: .98, insufficient: .01 } };
      return response;
    } }), repair: async () => { repairs++; return null; } });
  assert.equal(result.ok, false);
  assert.equal(result.checks[0].status, "rejected");
  assert.equal(calls, 1);
  assert.equal(repairs, 1);
  assert.deepEqual(state, before);
});

test("a fabricated historical quote cannot approve edited agreement terms through the optional review", () => {
  const state = { currentTurn: 2, draft: sourceText, historical_evidence: { sources: [{ turn: 1, role: "narrator", authority: "verified_narration", text: sourceText }] } };
  const answer = { id: "agreements", verdict: "consistent", reason: "Условия подтверждены", evidence: [{ path: "/historical_evidence/sources/0/text", quote: "Мира согласилась передать весь район." }] };
  assert.equal(parseNarrativeReview(JSON.stringify({ answers: [answer] }), ["agreements"], state), null);
  // Authentic text establishes provenance only; semantic entailment remains the reviewer obligation.
  assert.equal(parseNarrativeReview(JSON.stringify({ answers: [{ ...answer, evidence: [{ path: "/historical_evidence/sources/0/text", quote: sourceText }] }] }), ["agreements"], state)?.status, "verified");
});

test("bound replay rejects changed snapshot content even when the local snapshot version is unchanged", async () => {
  const selection = selectNarrativeChecks(guardInput());
  const state = { currentTurn: 2, draft: sourceText, accepted_changes: { agreements: [proposal] } };
  const recordings: JevRecording[] = [];
  const transport = recordingJevTransport(async ({ body }) => responseFor(JSON.parse(body).questions), recordings,
    { taskId: narrativeJevTask(selection, state).taskId, taskVersion: narrativeJevTask(selection, state).taskVersion });
  const outcome = await runJevTask(narrativeJevTask(selection, state, 2), { apiKey: "fixture-key", transport });
  assert.equal(outcome.status, "answered");
  assert.equal(outcome.snapshotVersion, 2);
  const good = await verifyNarrative({ selection, state, snapshotVersion: 2, apiKey: "fixture-key", transport: replayJevTransport(recordings) });
  assert.equal(good.status, "verified");
  const changed = { ...state, accepted_changes: { agreements: [{ ...proposal, object: "весь район" }] } };
  const stale = await verifyNarrative({ selection, state: changed, snapshotVersion: 2, apiKey: "fixture-key", transport: replayJevTransport(recordings) });
  assert.equal(stale.status, "unavailable");
  assert.equal(stale.reason, "provider_error");
});

test("real narrative adapter fails closed for malformed provider responses before guard acceptance", async () => {
  const selection = selectNarrativeChecks(guardInput());
  const valid = responseFor(selection.questions);
  const missing = structuredClone(valid);
  delete missing.answers.history_object;
  const malformed = structuredClone(valid);
  malformed.answers.history_object.probabilities.consistent = .1;
  for (const raw of [null, "not JSON", {}, missing, malformed, { ...valid, usage: null }]) {
    const transport: JevTransport = async () => raw;
    const result = await guardNarrative({ ...guardInput(), verify: async (state, scope) => verifyNarrative({ selection: scope, state, apiKey: "fixture-key", transport }),
      repair: async () => { assert.fail("an unavailable provider must not invoke repair"); } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "unavailable");
    assert.equal(result.checks[0].reason, "invalid_response");
  }
});

test("limited PostgreSQL evidence retrieval excludes future foreign and non-story candidates before ranking", async () => {
  const pg = new PGlite();
  try {
    await pg.exec("CREATE TABLE game_turns(id text, session_id text, turn_number int, role text, content text, state_changes jsonb, context_meta jsonb)");
    await pg.exec(await readFile("drizzle/0009_narrative_evidence_search.sql", "utf8"));
    await pg.query(`INSERT INTO game_turns SELECT 'history-' || n || '-' || role, 'a', n, role, 'Договор Миры об амулете.', null, null
      FROM generate_series(1,24) n CROSS JOIN (VALUES ('player'),('narrator')) roles(role)`);
    await pg.query(`INSERT INTO game_turns SELECT 'foreign-' || n, 'b', n, 'narrator', repeat('договор амулет ',200), null, null FROM generate_series(1,24) n`);
    await pg.exec(`INSERT INTO game_turns VALUES ('pending','a',25,'narrator','договор амулет',null,null),
      ('future','a',26,'narrator','договор амулет',null,null), ('system','a',1,'system','договор амулет',null,null)`);
    const query = buildNarrativeEvidenceQuery({ sessionId: "a", beforeTurn: 25, action: "договор амулет", sourceTurns: [1, 25, 26] });
    const rows = (await pg.query(query.text, query.values)).rows;
    const snapshot = snapshotNarrativeEvidence(rows);
    assert.equal(rows.length, 40);
    assert.deepEqual(snapshot.sources.slice(0, 2).map(s => s.id), ["history-1-narrator", "history-1-player"]);
    assert.deepEqual(snapshot.sources.slice(-2).map(s => s.id), ["history-24-narrator", "history-24-player"]);
    assert.equal(snapshot.sources.some(s => s.id === "history-2-narrator"), false);
    assert.equal(snapshot.sources.some(s => /foreign|pending|future|system/.test(s.id)), false);
    assert.equal(snapshot.sources.find(s => s.id === "history-1-player")?.authority, "intention");
    assert.equal(snapshot.completeHistory, false);
    assert.equal(snapshot.truncated, false);
  } finally { await pg.close(); }
});

test("agreement append binds only the final narrator source and a bad source causes zero journal effects", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE TABLE game_sessions(id uuid PRIMARY KEY); CREATE TABLE game_turns(id uuid PRIMARY KEY,session_id uuid,turn_number int,role text,content text);
      INSERT INTO game_sessions VALUES ('${sessionId}');`);
    await pg.query("INSERT INTO game_turns VALUES ($1,$2,2,'narrator',$3)", [narratorTurnId, sessionId, sourceText]);
    await pg.exec(await readFile("drizzle/0008_agreement_events.sql", "utf8"));
    const local = drizzle(pg);
    const revisions = reduce(proposal).accepted;
    await assert.rejects(local.transaction(tx => appendAgreementRevisions(tx, revisions, { narration: "Мира передала весь район.", narratorTurnId })),
      (error: unknown) => (error as { cause?: Error }).cause?.message === "AGREEMENT_SOURCE_MISMATCH");
    assert.deepEqual((await pg.query("SELECT count(*)::int AS count FROM agreement_events")).rows, [{ count: 0 }]);
    const saved = await local.transaction(tx => appendAgreementRevisions(tx, revisions, { narration: sourceText, narratorTurnId }));
    const history = await loadAgreementHistory(local, sessionId, 3);
    assert.equal(history.length, 1);
    assert.equal(saved[0].source.quote, sourceText);
    assert.equal(history[0].source.originTurnId, narratorTurnId);
    assert.equal(history[0].source.start, 0);
    assert.equal(history[0].source.end, 59);
    assert.equal(history[0].source.textSha256, "c85c4dc74dfb663ae4f610ebcbf3c28f543899e25b099f033cf2cd4d24beff02");
    assert.equal(revisions[0].source.quote, "");
  } finally { await pg.close(); }
});
