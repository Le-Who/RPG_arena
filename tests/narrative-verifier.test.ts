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
