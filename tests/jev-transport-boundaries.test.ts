import assert from "node:assert/strict";
import test from "node:test";
import { fetchJevTransport, runJevTask, type JevTask } from "../src/lib/jev-tasks";
import { verifyTypeSafeFacts } from "../src/lib/typesafe";

const task: JevTask<"supports" | "contradicts" | "unsupported"> = {
  taskId: "transport-boundary", taskVersion: "v1",
  labels: ["supports", "contradicts", "unsupported"],
  uncertainty: { insufficientLabel: "unsupported", minConfidence: 0.8, minProbability: 0.8 },
  state: {}, questions: { fact0: { type: "choice", instructions: "?", criteria: { supports: "", contradicts: "", unsupported: "" } } },
};
const answer = {
  model: "jev-1.13.0", answers: { fact0: { type: "choice", choice: "supports", confidence: 0.95,
    probabilities: { supports: 0.95, contradicts: 0.03, unsupported: 0.02 } } },
  usage: { input_tokens: 10, output_tokens: 2 },
};

for (const consumer of ["shared", "memory-pilot"] as const) {
  const run = (fetchImpl: typeof fetch, signal?: AbortSignal) => consumer === "shared"
    ? runJevTask(task, { apiKey: "synthetic", fetchImpl, signal })
    : verifyTypeSafeFacts({ enabled: true, apiKey: "synthetic", narration: "Ключ у героя.", playerAction: "Взять ключ",
      facts: [{ type: "event", title: "Ключ", content: "Ключ у героя.", evidence: "Ключ у героя.", confidence: 0.95, importance: 50, entityKey: "" }], fetchImpl });

  for (const declared of [true, false]) test(`${consumer} rejects an oversized provider body ${declared ? "before reading declared bytes" : "while streaming undeclared bytes"}`, async () => {
    let cancelled = 0;
    const payload = new TextEncoder().encode(JSON.stringify({ ...answer, ignored: "я".repeat(110_000) }));
    const result = await run(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(payload); },
      cancel() { cancelled++; },
    }), { headers: { "Content-Type": "application/json", ...(declared ? { "Content-Length": String(payload.byteLength) } : {}) } }));
    assert.equal(result.status, consumer === "shared" ? "unavailable" : "error");
    if ("reason" in result) assert.equal(result.reason, "invalid_response");
    assert.equal(cancelled, 1);
  });

  test(`${consumer} returns HTTP failure without waiting for unresponsive body cancellation`, async () => {
    const result = await run(async () => new Response(new ReadableStream({ cancel() { return new Promise<void>(() => {}); } }), { status: 503 }));
    if ("reason" in result) assert.equal(result.reason, "provider_error");
    else { assert.equal(result.status, "error"); assert.equal(result.error, "TypeSafe вернул HTTP 503."); }
  });

  test(`${consumer} accepts a complete bounded UTF-8 response`, async () => {
    const result = await run(async () => Response.json(answer));
    assert.equal(result.status, consumer === "shared" ? "answered" : "ok");
  });
}

test("shared Jev transport cancels a body returned after external cancellation", async () => {
  let release!: (response: Response) => void, entered!: () => void, cancelled = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const controller = new AbortController();
  const pending = runJevTask(task, { apiKey: "synthetic", signal: controller.signal, fetchImpl: async () => {
    entered(); return new Promise<Response>(resolve => { release = resolve; });
  } });
  await started;
  controller.abort();
  assert.equal((await pending).reason, "aborted");
  release(new Response(new ReadableStream({ cancel() { cancelled++; } })));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1);
});

test("shared Jev transport cancels a stalled body on external cancellation", async () => {
  let entered!: () => void, cancelled = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const controller = new AbortController();
  const pending = runJevTask(task, { apiKey: "synthetic", signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({
    pull() { entered(); }, cancel() { cancelled++; },
  })) });
  await started;
  controller.abort();
  assert.equal((await pending).reason, "aborted");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1);
});

test("Jev response byte limit is inclusive and independent of Content-Length", async () => {
  const encoded = new TextEncoder().encode(JSON.stringify(answer));
  for (const size of [199_999, 200_000, 200_001]) {
    const payload = new Uint8Array(size).fill(32);
    payload.set(encoded, size - encoded.byteLength);
    const outcome = await runJevTask(task, { apiKey: "synthetic", fetchImpl: async () => new Response(payload) });
    assert.equal(outcome.status, size <= 200_000 ? "answered" : "unavailable", `${size} bytes`);
    if (size > 200_000) assert.equal(outcome.reason, "invalid_response");
  }
});

test("Jev transport preserves UTF-8 split across chunks and rejects malformed UTF-8", async () => {
  const valid = new TextEncoder().encode(JSON.stringify({ ...answer, ignored: "я😀" }));
  const decoded = await fetchJevTransport(async () => new Response(new ReadableStream({
    start(controller) { for (const byte of valid) controller.enqueue(new Uint8Array([byte])); controller.close(); },
  })))({ taskId: task.taskId, taskVersion: task.taskVersion, provider: "typesafe", endpoint: "https://fixture.invalid", body: "{}", apiKey: "synthetic", signal: new AbortController().signal });
  assert.deepEqual(decoded, { ...answer, ignored: "я😀" });
  const invalid = new TextEncoder().encode(JSON.stringify({ ...answer, ignored: "x" }));
  invalid[invalid.length - 3] = 255;
  const outcome = await runJevTask(task, { apiKey: "synthetic", fetchImpl: async () => new Response(invalid) });
  assert.equal(outcome.reason, "invalid_response");
});
