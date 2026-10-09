import assert from "node:assert/strict";
import test from "node:test";
import { verifyNarrative } from "../src/lib/narrative-verifier";
import { selectNarrativeChecks } from "../src/lib/narrative-policy";

const selection = selectNarrativeChecks({ action: "Напомнить договор", narration: "Получил вещь", declaration: null, hasDice: true, hasStateChanges: true, rejected: [] });
const options = () => ({ selection, apiKey: "private-test-key", state: { draft: "Получил вещь", historical_evidence: [] }, timeoutMs: 1000 });
const response = () => ({ model: "jev-1.13.0", answers: Object.fromEntries(Object.keys(selection.questions).map(id => [id, { type: "choice", choice: "consistent", probabilities: { consistent: .98, contradicts: .01, insufficient: .01 }, confidence: .95 }])), usage: { input_tokens: 100, output_tokens: 0 } });

test("all atomic checks are batched once and only consistently confident answers pass", async () => {
  let calls = 0;
  const result = await verifyNarrative({ ...options(), fetchImpl: async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(body.questions), Object.keys(selection.questions));
    assert.equal(body.state.draft, "Получил вещь");
    return Response.json(response());
  } });
  assert.equal(calls, 1);
  assert.equal(result.status, "verified");
  assert.ok(!JSON.stringify(result).includes("private-test-key"));
});

test("outgoing accepted-notes question covers final life, agenda and social canon and propagates its verdict", async () => {
  const state = {
    draft: "Анна смотрит на воду.", player_action: "Напомнить Анне договор", before_state: { world: { commitments: [], agenda: [], npcAgendas: [], npcSchedules: [], npcBonds: [] } },
    accepted_changes: { operations: [], flags: {}, world: {
      commitments: [{ title: "Ужин", note: "Анна обещала его ещё вчера." }],
      agenda: [{ title: "Встреча", note: "Срок был согласован на прошлом ходу." }],
      npcAgendas: [{ key: "anna", goal: "Вернуть ранее полученный ключ", routine: "Приходит по старому договору" }],
      npcSchedules: [{ npcKey: "anna", place: "Причал", note: "Так договорились вчера." }],
      npcBonds: [{ key: "anna", history: [{ text: "Герой исполнил старое обещание" }], knows: [{ text: "Ключ был передан вчера" }] }],
    } }, historical_evidence: { sources: [{ role: "player", authority: "intention", text: "Хочу передать ключ" }], agreements: [] },
  };
  for (const verdict of ["consistent", "contradicts"] as const) {
    let outgoing: { state: unknown; questions: Record<string, { instructions: string; criteria: Record<string, string> }> } | undefined;
    const answers = response();
    answers.answers.accepted_notes.choice = verdict;
    answers.answers.accepted_notes.probabilities = verdict === "consistent"
      ? { consistent: .98, contradicts: .01, insufficient: .01 } : { consistent: .01, contradicts: .98, insufficient: .01 };
    const result = await verifyNarrative({ ...options(), state, fetchImpl: async (_url, init) => {
      outgoing = JSON.parse(String(init?.body));
      return Response.json(answers);
    } });
    assert.ok(outgoing, "the real adapter must send the selected notes question");
    const instructions = outgoing.questions.accepted_notes.instructions;
    for (const path of ["accepted_changes.operations", "accepted_changes.flags", "accepted_changes.world.commitments", "accepted_changes.world.agenda",
      "accepted_changes.world.npcAgendas", "accepted_changes.world.npcSchedules", "accepted_changes.world.npcBonds", "before_state.world", "historical_evidence"]) {
      assert.ok(instructions.includes(path), `the outgoing notes question must cover ${path}`);
    }
    assert.deepEqual(outgoing.state, state);
    assert.deepEqual(Object.keys(outgoing.questions.accepted_notes.criteria), ["consistent", "contradicts", "insufficient"]);
    assert.equal(result.status, verdict === "consistent" ? "verified" : "rejected");
    assert.equal(result.answers.accepted_notes.choice, verdict);
  }
});

test("contradictions, insufficient evidence and low confidence never pass", async () => {
  for (const variant of ["contradicts", "insufficient", "low-confidence"]) {
    const body = response();
    const answer = body.answers.history_object;
    if (variant === "low-confidence") answer.confidence = .4;
    else { answer.choice = variant; answer.probabilities = { consistent: .01, contradicts: variant === "contradicts" ? .98 : .01, insufficient: variant === "insufficient" ? .98 : .01 }; }
    const result = await verifyNarrative({ ...options(), fetchImpl: async () => Response.json(body) });
    assert.equal(result.status, variant === "contradicts" ? "rejected" : "uncertain");
  }
});

test("missing answers, malformed probabilities, wrong model and extra answers fail closed", async () => {
  for (const mutate of [
    (body: ReturnType<typeof response>) => { delete body.answers.history_object; },
    (body: ReturnType<typeof response>) => { body.answers.history_object.probabilities.consistent = .4; },
    (body: ReturnType<typeof response>) => { body.model = "unknown"; },
    (body: ReturnType<typeof response>) => { body.answers.extra = body.answers.history_object; },
  ]) {
    const body = response(); mutate(body);
    assert.equal((await verifyNarrative({ ...options(), fetchImpl: async () => Response.json(body) })).status, "unavailable");
  }
});

test("no key, oversized state, HTTP error and abort are explicit and do not disclose provider bodies", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => { calls++; return new Response("sensitive-provider-body", { status: 500 }); };
  assert.equal((await verifyNarrative({ ...options(), apiKey: "", fetchImpl })).reason, "missing_key");
  assert.equal((await verifyNarrative({ ...options(), state: { text: "x".repeat(150000) }, fetchImpl })).reason, "input_too_large");
  assert.equal(calls, 0);
  const failure = await verifyNarrative({ ...options(), fetchImpl });
  assert.equal(failure.status, "unavailable");
  assert.ok(!JSON.stringify(failure).includes("sensitive-provider-body"));
  const timeout = await verifyNarrative({ ...options(), timeoutMs: 5, fetchImpl: async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))) });
  assert.equal(timeout.reason, "timeout");
});

test("unchecked description consumes no provider call and has a distinct skipped status", async () => {
  const result = await verifyNarrative({ ...options(), selection: { required: false, reasons: [], questions: {} }, fetchImpl: async () => { throw new Error("must not call"); } });
  assert.equal(result.status, "skipped");
});

test("OpenRouter credentials use only Decisions endpoint and requested Jev model", async () => {
  const result = await verifyNarrative({ ...options(), provider: "openrouter", fetchImpl: async (url, init) => {
    assert.equal(url, "https://openrouter.ai/api/alpha/decisions");
    assert.equal(JSON.parse(String(init?.body)).model, "typesafe/jev-1.13");
    assert.equal(init?.redirect, "error");
    return Response.json({ ...response(), model: "typesafe/jev-1.13", usage: { input_tokens: 100, output_tokens: 0, cost: .00001 } });
  } });
  assert.equal(result.status, "verified");
  assert.equal(result.provider, "openrouter");
  assert.equal(result.usage?.cost, .00001);
});
