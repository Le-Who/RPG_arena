import test from "node:test";
import assert from "node:assert/strict";
import { parseNarrativeReview } from "../src/lib/narrative-review";

const state = { draft: "Тебе отказали.", dice: { success: false }, before_state: { inventory: [{ name: "факел", quantity: 1 }] } };
const answer = () => ({ id: "outcome", verdict: "consistent", reason: "Отказ соответствует провалу.", evidence: [{ path: "/dice/success", quote: "false" }, { path: "/draft", quote: "Тебе отказали." }] });
const parse = (answers: unknown[]) => parseNarrativeReview(JSON.stringify({ answers }), ["outcome"], state);

test("review accepts only complete decisions with references matching immutable state", () => {
  assert.equal(parse([answer()])?.status, "verified");
  assert.equal(parse([{ ...answer(), verdict: "contradicts" }])?.status, "rejected");
  assert.equal(parse([{ ...answer(), verdict: "insufficient" }])?.status, "uncertain");
  assert.equal(parse([{ ...answer(), evidence: [{ path: "/before_state/inventory/0", quote: '{"quantity":1,"name":"факел"}' }] }])?.status, "verified");
});

test("wrong question IDs, duplicate decisions and invented evidence cannot approve a draft", () => {
  for (const answers of [[], [answer(), answer()], [{ ...answer(), id: "independent_additions" }],
    [{ ...answer(), evidence: [] }], [{ ...answer(), evidence: [{ path: "/dice/success", quote: "true" }] }],
    [{ ...answer(), evidence: [{ path: "/state/dice/success", quote: "false" }] }],
    [{ ...answer(), evidence: [{ path: "/constructor/name", quote: "Object" }] }],
    [{ ...answer(), evidence: [{ path: "/before_state/inventory/0", quote: '{"name":"факел","quantity":2}' }] }],
    [{ ...answer(), verdict: "maybe" }], [{ ...answer(), reason: "" }],
  ]) assert.equal(parse(answers), null);
});

test("duplicate JSON keys and extra response fields are rejected", () => {
  const answers = JSON.stringify([answer()]);
  assert.equal(parseNarrativeReview(`{"answers":[],"answers":${answers}}`, ["outcome"], state), null);
  assert.equal(parseNarrativeReview(JSON.stringify({ answers: [answer()], approved: true }), ["outcome"], state), null);
});

test("a request or unverified narration cannot establish a historical contradiction", () => {
  for (const source of [
    { role: "player", text: "Прошу лодку" },
    { role: "narrator", authority: "legacy_narration", text: "Лодка обещана" },
    { role: "narrator", authority: "disputed_narration", text: "Лодка обещана" },
  ]) {
    const check = { ...answer(), id: "history_status", verdict: "contradicts", evidence: [{ path: "/historical_evidence/0/text", quote: source.text }] };
    const result = parseNarrativeReview(JSON.stringify({ answers: [check] }), [check.id], { ...state, historical_evidence: [source] });
    assert.equal(result?.status, "uncertain");
    assert.equal(result?.answers[0].reportedVerdict, "contradicts");
    assert.equal(result?.answers[0].verdict, "insufficient");
  }
});

test("confirmed history can establish a contradiction but current candidates and future sources cannot", () => {
  const check = { ...answer(), id: "history_status", verdict: "contradicts", evidence: [{ path: "/historical_evidence/sources/0/text", quote: "Лодка не передана" }] };
  for (const turn of [3, 10]) {
    const result = parseNarrativeReview(JSON.stringify({ answers: [check] }), [check.id], { ...state, currentTurn: 10,
      historical_evidence: { sources: [{ turn, authority: "confirmed_event", text: "Лодка не передана" }] } });
    assert.equal(result?.status, turn === 3 ? "rejected" : "uncertain");
  }
  const candidate = { ...check, evidence: [{ path: "/accepted_changes/agreements/0/object", quote: "район" }] };
  assert.equal(parseNarrativeReview(JSON.stringify({ answers: [candidate] }), [candidate.id], { ...state, accepted_changes: { agreements: [{ object: "район" }] } })?.status, "uncertain");
});

test("independent acquisition approval requires a citation outside the draft and provisional changes", () => {
  const id = "independent_acquisitions";
  const check = { ...answer(), id, evidence: [{ path: "/draft", quote: state.draft }] };
  assert.equal(parseNarrativeReview(JSON.stringify({ answers: [check] }), [id], state)?.status, "uncertain");
  const supported = { ...check, evidence: [{ path: "/before_state/delivery", quote: "Заказ оплачен и доставлен" }] };
  assert.equal(parseNarrativeReview(JSON.stringify({ answers: [supported] }), [id], { ...state, before_state: { delivery: "Заказ оплачен и доставлен" } })?.status, "verified");
});

test("path-only citations are filled from the frozen snapshot, without model-rewritten JSON", () => {
  const check = { ...answer(), evidence: [{ path: "/before_state/inventory/0" }] };
  const result = parse([check]);
  assert.equal(result?.status, "verified");
  assert.deepEqual(JSON.parse(result!.answers[0].evidence[0].quote), state.before_state.inventory[0]);
  assert.equal(parse([{ ...check, evidence: [{ path: "/missing" }] }]), null);
  assert.equal(parse([{ ...check, evidence: [{ path: "/draft", unexpected: true }] }]), null);
  assert.equal(parseNarrativeReview(JSON.stringify({ answers: [{ ...check, evidence: [{ path: "/draft" }] }] }), ["outcome"], { draft: "x".repeat(12001) }), null);
});

test("multiple checks can cite the same maximum-length draft without exhausting evidence coverage", () => {
  const draft = "x".repeat(12000);
  const ids = ["accepted_state", "outcome", "history_parties", "history_object", "history_terms", "history_time", "history_status"];
  const answers = ids.map(id => ({ ...answer(), id, evidence: [{ path: "/draft" }] }));
  assert.equal(parseNarrativeReview(JSON.stringify({ answers }), ids, { draft })?.status, "verified");
});

test("no accepted operation is lack of support, not evidence that the opposite happened", () => {
  for (const id of ["accepted_state", "unlisted_events"]) {
    const check = { ...answer(), id, verdict: "contradicts", evidence: [{ path: "/accepted_changes" }] };
    assert.equal(parseNarrativeReview(JSON.stringify({ answers: [check] }), [id], { ...state, accepted_changes: [] })?.status, "uncertain");
    const denied = { ...check, evidence: [{ path: "/rejected_changes/0" }] };
    assert.equal(parseNarrativeReview(JSON.stringify({ answers: [denied] }), [id], { ...state, rejected_changes: ["Предмет не получен: действие провалено"] })?.status, "rejected");
  }
});
