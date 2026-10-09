import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { decideJevAnswer, parseJevResponse, replayJevTransport, recordingJevTransport, runJevTask, summarizeJevOutcome, type JevTask } from "../src/lib/jev-tasks";
import { narrativeJevTask, verifyNarrative } from "../src/lib/narrative-verifier";
import { factVerificationJevTask, verifyTypeSafeFacts } from "../src/lib/typesafe";
import { buildMechanicsShadowTask, compareMechanicsOutcome, runMechanicsShadow, MECHANICS_TASK_VERSION } from "../src/lib/jev-mechanics";
import { selectNarrativeChecks } from "../src/lib/narrative-policy";

type Label = "yes" | "no" | "unsure";
const task = (questions = ["q0"]): JevTask<Label> => ({
  taskId: "unit", taskVersion: "v1", labels: ["yes", "no", "unsure"], uncertainty: { insufficientLabel: "unsure", minConfidence: 0.8, minProbability: 0.8 },
  state: { text: "данные" }, questions: Object.fromEntries(questions.map((id) => [id, { type: "choice" as const, instructions: "?", criteria: { yes: "", no: "", unsure: "" } }])),
  strictProbabilities: true, snapshotVersion: 7,
});
const answer = (choice: Label, confidence = 0.95) => ({ type: "choice", choice, confidence, probabilities: { yes: choice === "yes" ? 0.9 : 0.05, no: choice === "no" ? 0.9 : 0.05, unsure: choice === "unsure" ? 0.9 : 0.05 } });
const response = (answers: Record<string, unknown>, model = "jev-1.13.0") => ({ model, answers, usage: { input_tokens: 10, output_tokens: 2 } });

test("UTF-8 byte budgets reject Cyrillic payloads before transport", async () => {
  const input = task();
  input.state = { text: "я".repeat(100) };
  const body = JSON.stringify({ model: "jev-1.13.0", state: input.state, questions: input.questions });
  let called = false;
  const result = await runJevTask({ ...input, limits: { maxBodyBytes: body.length + 1 } }, { apiKey: "k", transport: async () => { called = true; return response({ q0: answer("yes") }); } });
  assert.equal(result.reason, "input_too_large");
  assert.equal(called, false);
});

test("usage observer failure does not erase a valid decision or its usage", async () => {
  const result = await runJevTask(task(), { apiKey: "k", transport: async () => response({ q0: answer("yes") }), onUsage: () => { throw new Error("sink offline"); } });
  assert.equal(result.status, "answered");
  assert.equal(result.usage?.inputTokens, 10);
});

test("asynchronous usage observer failure is contained without delaying the answer", async () => {
  const result = await runJevTask(task(), { apiKey: "k", transport: async () => response({ q0: answer("yes") }), onUsage: async () => { throw new Error("async sink offline"); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.status, "answered");
  assert.equal(result.usage?.inputTokens, 10);
});

test("replay is bound to task version and request hash, and returns detached responses", async () => {
  const input = task();
  const body = JSON.stringify({ model: "jev-1.13.0", state: input.state, questions: input.questions });
  const recording = { taskId: "unit", taskVersion: "v1", provider: "typesafe" as const, bodySha256: createHash("sha256").update(body).digest("hex"), response: response({ q0: answer("yes") }) };
  const wrongVersion = await runJevTask({ ...input, taskVersion: "v2" }, { apiKey: "k", transport: replayJevTransport([recording]) });
  assert.equal(wrongVersion.reason, "provider_error");
  const wrongBody = await runJevTask({ ...input, state: { text: "changed" } }, { apiKey: "k", transport: replayJevTransport([recording]) });
  assert.equal(wrongBody.reason, "provider_error");
});

test("a recorded narrative decision from the old notes scope cannot authorize the expanded final-canon task", async () => {
  const selection = selectNarrativeChecks({ action: "Напомнить договор", narration: "Анна молчит.", declaration: { mode: "event", referencesPast: false }, hasDice: false, hasStateChanges: true, rejected: [] });
  const recordedResponse = response(Object.fromEntries(Object.keys(selection.questions).map(id => [id, {
    type: "choice", choice: "consistent", confidence: .95, probabilities: { consistent: .98, contradicts: .01, insufficient: .01 },
  }])));
  // No body hash: this negative isolates the task-version precondition alone.
  const old = replayJevTransport([{ taskId: "narrative-consistency", taskVersion: "2026-09-default-fallback-v1", provider: "typesafe", response: recordedResponse }]);
  const denied = await verifyNarrative({ selection, state: { accepted_changes: { world: { commitments: [] } } }, apiKey: "synthetic", transport: old });
  assert.equal(denied.status, "unavailable");
  assert.equal(denied.reason, "provider_error");
  const current = replayJevTransport([{ taskId: "narrative-consistency", taskVersion: "2026-10-09-final-canon-notes-v2", provider: "typesafe", response: recordedResponse }]);
  const accepted = await verifyNarrative({ selection, state: { accepted_changes: { world: { commitments: [] } } }, apiKey: "synthetic", transport: current });
  assert.equal(accepted.status, "verified");
});

test("inherited answer keys cannot satisfy provider coverage", () => {
  const input = task(["toString"]);
  const inherited = Object.create({ toString: answer("yes") });
  inherited.unrelated = answer("yes");
  assert.throws(() => parseJevResponse(response(inherited), input, "typesafe"));
});

test("recording rejects mismatched task metadata before contacting provider", async () => {
  let calls = 0;
  const transport = recordingJevTransport(async () => { calls++; return response({ q0: answer("yes") }); }, [], { taskId: "other", taskVersion: "v1" });
  const result = await runJevTask(task(), { apiKey: "k", transport });
  assert.equal(result.status, "unavailable");
  assert.equal(calls, 0);
});

// ── JEV-3a: общий контракт ──

test("runJevTask returns typed answers with usage, snapshot version and never throws on transport failures", async () => {
  const transport = replayJevTransport([{ taskId: "unit", taskVersion: "v1", provider: "typesafe", response: response({ q0: answer("yes") }) }]);
  const outcome = await runJevTask(task(), { apiKey: "k", transport });
  assert.equal(outcome.status, "answered");
  assert.equal(outcome.answers.q0.choice, "yes");
  assert.equal(outcome.snapshotVersion, 7);
  assert.deepEqual(outcome.usage, { inputTokens: 10, outputTokens: 2 });
  assert.equal(transport.calls.length, 1);
  const body = JSON.parse(transport.calls[0].body);
  assert.equal(body.model, "jev-1.13.0");
  assert.ok(!("apiKey" in body) && !JSON.stringify(body).includes("Bearer"));
  // Replay exhausted → provider_error, not an exception.
  const again = await runJevTask(task(), { apiKey: "k", transport });
  assert.equal(again.status, "unavailable");
  assert.equal(again.reason, "provider_error");
});

test("missing key, empty coverage, oversized input and invalid responses are distinct unavailable reasons", async () => {
  assert.equal((await runJevTask(task(), { apiKey: " " })).reason, "missing_key");
  assert.equal((await runJevTask(task([]), { apiKey: "k" })).reason, "question_coverage");
  assert.equal((await runJevTask({ ...task(), limits: { maxBodyBytes: 10 } }, { apiKey: "k" })).reason, "input_too_large");
  const bad = await runJevTask(task(), { apiKey: "k", transport: async () => response({ q0: { ...answer("yes"), probabilities: { yes: 0.5, no: 0.5, unsure: 0.5 } } }) });
  assert.equal(bad.reason, "invalid_response");
  const wrongModel = await runJevTask(task(), { apiKey: "k", transport: async () => response({ q0: answer("yes") }, "gpt-x") });
  assert.equal(wrongModel.reason, "invalid_response");
  const openrouter = await runJevTask(task(), { apiKey: "k", provider: "openrouter", transport: async () => response({ q0: answer("yes") }, "typesafe/jev-1.13-20260901") });
  assert.equal(openrouter.status, "answered");
  assert.equal(openrouter.model, "typesafe/jev-1.13-20260901");
});

test("timeouts and external cancellation are reported explicitly", async () => {
  const slow = () => new Promise<never>(() => undefined);
  const timedOut = await runJevTask(task(), { apiKey: "k", timeoutMs: 10, transport: slow });
  assert.equal(timedOut.reason, "timeout");
  const controller = new AbortController();
  const pending = runJevTask(task(), { apiKey: "k", timeoutMs: 5000, signal: controller.signal, transport: ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))) });
  controller.abort();
  assert.equal((await pending).reason, "aborted");
});

test("server policy: insufficient label or low confidence never becomes acceptance; absence is unavailable", () => {
  const policy = { insufficientLabel: "unsure" as const, acceptLabel: "yes" as const, rejectLabel: "no" as const, minConfidence: 0.8, minProbability: 0.8 };
  assert.equal(decideJevAnswer(undefined, policy), "unavailable");
  assert.equal(decideJevAnswer({ choice: "yes", confidence: 0.95, probabilities: { yes: 0.95, no: 0.03, unsure: 0.02 } }, policy), "accept");
  assert.equal(decideJevAnswer({ choice: "yes", confidence: 0.5, probabilities: { yes: 0.95, no: 0.03, unsure: 0.02 } }, policy), "insufficient");
  assert.equal(decideJevAnswer({ choice: "no", confidence: 0.9, probabilities: { yes: 0.05, no: 0.9, unsure: 0.05 } }, policy), "reject");
  assert.equal(decideJevAnswer({ choice: "unsure", confidence: 0.99, probabilities: { yes: 0, no: 0, unsure: 1 } }, policy), "insufficient");
  const parsed = parseJevResponse(response({ q0: answer("yes"), q1: answer("no") }), task(["q0", "q1"]), "typesafe");
  assert.equal(summarizeJevOutcome({ taskId: "unit", taskVersion: "v1", provider: "typesafe", model: parsed.model, status: "answered", answers: parsed.answers, latencyMs: 1 }, policy), "reject");
});

// ── JEV-3a: адаптеры существующих потребителей ──

test("narrative verifier keeps its contract while running through the shared task layer", async () => {
  const selection = { required: true, reasons: ["dice"], questions: { outcome: { type: "choice" as const, instructions: "?", criteria: { consistent: "", contradicts: "", insufficient: "" } } } };
  const jev = narrativeJevTask(selection, { a: 1 }, 12);
  assert.equal(jev.taskId, "narrative-consistency");
  assert.equal(jev.strictProbabilities, true);
  const ok = await verifyNarrative({ selection, state: { a: 1 }, apiKey: "k", transport: async () => response({ outcome: { type: "choice", choice: "consistent", confidence: 0.95, probabilities: { consistent: 0.95, contradicts: 0.03, insufficient: 0.02 } } }) });
  assert.equal(ok.status, "verified");
  const rejected = await verifyNarrative({ selection, state: { a: 1 }, apiKey: "k", transport: async () => response({ outcome: { type: "choice", choice: "contradicts", confidence: 0.9, probabilities: { consistent: 0.05, contradicts: 0.92, insufficient: 0.03 } } }) });
  assert.equal(rejected.status, "rejected");
  const uncertain = await verifyNarrative({ selection, state: { a: 1 }, apiKey: "k", transport: async () => response({ outcome: { type: "choice", choice: "consistent", confidence: 0.6, probabilities: { consistent: 0.6, contradicts: 0.3, insufficient: 0.1 } } }) });
  assert.equal(uncertain.status, "uncertain");
  const skipped = await verifyNarrative({ selection: { required: false, reasons: [], questions: {} }, state: {}, apiKey: "k" });
  assert.equal(skipped.status, "skipped");
  const noKey = await verifyNarrative({ selection, state: {}, apiKey: "" });
  assert.deepEqual([noKey.status, noKey.reason], ["unavailable", "missing_key"]);
});

test("memory fact verification maps the shared outcome back to the pilot report", async () => {
  const facts = [{ content: "Герой получил ключ", evidence: "Ключ лёг в ладонь", type: "event", importance: 50, layer: "episodic" as const }] as unknown as Parameters<typeof verifyTypeSafeFacts>[0]["facts"];
  const jev = factVerificationJevTask({ facts, narration: "Ключ лёг в ладонь.", playerAction: "Взять ключ" });
  assert.equal(jev.taskId, "memory-fact-verification");
  assert.deepEqual(Object.keys(jev.questions), ["fact0"]);
  const report = await verifyTypeSafeFacts({ enabled: true, apiKey: "k", facts, narration: "Ключ лёг в ладонь.", playerAction: "Взять ключ", transport: async () => response({ fact0: { type: "choice", choice: "supports", confidence: 0.9, probabilities: { supports: 0.9, contradicts: 0.05, unsupported: 0.05 } } }) });
  assert.equal(report.status, "ok");
  assert.equal(report.evaluations[0].choice, "supports");
  assert.deepEqual(report.usage, { inputTokens: 10, outputTokens: 2 });
});

// ── JEV-3b: теневая проверка механик ──

const shadowInput = {
  heroName: "Мира", playerAction: "Перевязать рану Олегу", narration: "Мира туго перевязала плечо Олега. Анна сказала: «Я в пекарне с семи до трёх». Олег услышал, что склад заминирован.",
  turnNumber: 9, removedConditions: ["ранение"], restoredConditions: [],
  schedules: [{ name: "Анна", place: "Пекарня", window: "ежедневно 07:00–15:00", evidence: "Я в пекарне с семи до трёх" }],
  knowledge: [{ name: "Олег", fact: "склад заминирован", evidence: "Олег услышал" }],
};

test("mechanics shadow task asks about recipient, schedule time and NPC knowledge; heuristic decisions are recorded", () => {
  const built = buildMechanicsShadowTask(shadowInput);
  assert.ok(built);
  assert.deepEqual(built.meta.map((m) => [m.kind, m.heuristic]), [["recovery", "applied"], ["schedule", "applied"], ["knowledge", "applied"]]);
  assert.equal(built.task.taskVersion, MECHANICS_TASK_VERSION);
  assert.equal(built.task.snapshotVersion, 9);
  assert.match(built.task.questions.recovery0.instructions, /Мира/);
  assert.equal(buildMechanicsShadowTask({ ...shadowInput, removedConditions: [], schedules: [], knowledge: [] }), null);
});

test("shadow comparison flags disagreement when the model says another person received the cure, and never mutates input", async () => {
  const before = JSON.stringify(shadowInput);
  const answers = {
    recovery0: { type: "choice", choice: "other_party", confidence: 0.9, probabilities: { confirmed: 0.05, other_party: 0.9, intent_only: 0.02, negated: 0.01, insufficient: 0.02 } },
    schedule0: { type: "choice", choice: "confirmed", confidence: 0.92, probabilities: { confirmed: 0.92, other_party: 0.02, intent_only: 0.02, negated: 0.01, insufficient: 0.03 } },
    knowledge0: { type: "choice", choice: "insufficient", confidence: 0.7, probabilities: { confirmed: 0.3, other_party: 0.1, intent_only: 0.1, negated: 0.0, insufficient: 0.5 } },
  };
  const report = await runMechanicsShadow(shadowInput, { apiKey: "k", transport: async () => response(answers) });
  assert.ok(report);
  assert.equal(report.mode, "shadow");
  assert.deepEqual(report.questions.map((q) => [q.id, q.decision, q.agrees]), [["recovery0", "reject", false], ["schedule0", "accept", true], ["knowledge0", "insufficient", null]]);
  assert.equal(report.agreementRate, 0.5);
  assert.equal(report.uncertainRate, 0.33);
  assert.equal(JSON.stringify(shadowInput), before);
  const unavailable = await runMechanicsShadow(shadowInput, { apiKey: "" });
  assert.equal(unavailable?.status, "unavailable");
  assert.ok(unavailable?.questions.every((q) => q.decision === "unavailable" && q.agrees === null));
  const built = buildMechanicsShadowTask({ ...shadowInput, removedConditions: [], restoredConditions: ["усталость"] })!;
  const restored = compareMechanicsOutcome({ taskId: "t", taskVersion: "v", provider: "typesafe", model: "jev-1.13.0", status: "answered", latencyMs: 1,
    answers: { recovery0: { choice: "intent_only", confidence: 0.9, probabilities: { confirmed: 0.05, other_party: 0.02, intent_only: 0.9, negated: 0.01, insufficient: 0.02 } } } as never }, built.meta.filter((m) => m.kind === "recovery"));
  assert.equal(restored.questions[0].agrees, true);
});

test("shadow reports incomplete coverage and rejects malformed distributions", async () => {
  const input = { ...shadowInput, removedConditions: Array.from({ length: 10 }, (_, i) => `усталость ${i}`), schedules: [], knowledge: [] };
  const built = buildMechanicsShadowTask(input)!;
  assert.deepEqual(built.coverage, { total: 10, assessed: 8, omitted: 2 });
  const malformed = Object.fromEntries(Object.keys(built.task.questions).map(id => [id, { type: "choice", choice: "confirmed", confidence: 1,
    probabilities: { confirmed: 1, other_party: 1, intent_only: 1, negated: 1, insufficient: 1 } }]));
  const report = await runMechanicsShadow(input, { apiKey: "k", transport: async () => response(malformed) });
  assert.equal(report?.status, "unavailable");
  assert.equal(report?.reason, "invalid_response");
  assert.deepEqual(report?.coverage, built.coverage);
});
