import test from "node:test";
import assert from "node:assert/strict";
import { callTextWithConfig } from "../src/lib/text-provider";
import { loadTextModelCatalog } from "../src/lib/text-model-catalog";
import { GET } from "../src/app/api/settings/text-provider/models/route";
import type { AttemptInfo, GeminiCallOptions } from "../src/lib/gemini-transport";

const config = { textProvider: "openrouter" as const, textApiKey: "synthetic-only" };
const base = { keys: [], models: ["selected/model"], system: "system", user: "user" };
const encoder = new TextEncoder();
const event = (text: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] })}\n\n`;
const complete = () => Response.json({ choices: [{ index: 0, message: { content: "Готово" }, finish_reason: "stop" }] });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// Only the external HTTP boundary is synthetic; decoding, framing and cancellation stay real.
function sse(chunks: Uint8Array[], cancelled?: () => void) {
  let next = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < chunks.length) controller.enqueue(chunks[next++]);
      else controller.close();
    },
    cancel() { cancelled?.(); },
  }), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

test("multiline CRLF SSE survives every UTF-8 byte boundary and ignores nonzero choices/reasoning", async t => {
  // Catches parsing each data line independently or decoding fragmented Unicode without streaming.
  const wire = ': keepalive\r\nevent: message\r\nid: 17\r\nretry: 1000\r\n'
    + 'data: {"choices":[{"index":1,"delta":{"content":"Чужой"}},\r\n'
    + 'data: {"index":0,"delta":{"content":"Привет 🌿","reasoning":"скрыто"}}]}\r\n\r\n'
    + 'data: {"choices":[{"index":0,"delta":{"content":"!"},"finish_reason":"stop"}]}\r\n\r\n'
    + 'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":4,"completion_tokens_details":{"reasoning_tokens":2},"prompt_tokens_details":{"cached_tokens":3}}}\r\n\r\n'
    + 'data: [DONE]';
  const bytes = encoder.encode(wire), deltas: string[] = [];
  t.mock.method(globalThis, "fetch", async () => sse(Array.from(bytes, byte => Uint8Array.of(byte))));
  const result = await callTextWithConfig(config, { ...base, onText: delta => { deltas.push(delta); } });
  assert.equal(result.text, "Привет 🌿!");
  assert.deepEqual(deltas, ["Привет 🌿", "!"]);
  assert.equal(result.promptTokens, 11); assert.equal(result.completionTokens, 4);
  assert.equal(result.thoughtTokens, 2); assert.equal(result.cachedTokens, 3);
});

for (const size of [200_000, 200_001]) test(`generated SSE content ${size} characters respects the output cap`, async t => {
  // Removing the output cap would let the oversized result succeed despite a legal wire/frame size.
  const deltas: string[] = [];
  t.mock.method(globalThis, "fetch", async () => sse([encoder.encode(event("x".repeat(size)))]));
  const work = callTextWithConfig(config, { ...base, timeoutMs: 260, onText: delta => { deltas.push(delta); } });
  if (size === 200_000) {
    assert.equal((await work).text.length, 200_000);
    assert.equal(deltas.length, 1); assert.equal(deltas[0].length, 200_000);
  } else {
    await assert.rejects(work, /AI_DEADLINE:RESPONSE_TOO_LARGE/);
    assert.deepEqual(deltas, []);
  }
});

for (const size of [250_000, 250_001]) test(`multiline SSE joined payload of ${size} characters respects the frame cap`, async t => {
  // The joined newline consumes frame space, even though it is JSON whitespace.
  const first = '{"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],';
  const second = '"ignored":"' + "x".repeat(size - first.length - '\n"ignored":""}'.length) + '"}';
  assert.equal(`${first}\n${second}`.length, size);
  const deltas: string[] = [];
  t.mock.method(globalThis, "fetch", async () => sse([encoder.encode(`data: ${first}\r\ndata: ${second}\r\n\r\n`)]));
  const work = callTextWithConfig(config, { ...base, timeoutMs: 260, onText: delta => { deltas.push(delta); } });
  if (size === 250_000) { assert.equal((await work).text, "ok"); assert.deepEqual(deltas, ["ok"]); }
  else { await assert.rejects(work, /AI_DEADLINE:STREAM_FRAME_TOO_LARGE/); assert.deepEqual(deltas, []); }
});

for (const size of [2_000_000, 2_000_001]) test(`SSE comments count toward the ${size}-byte wire boundary`, async t => {
  // Discarding comments must not discard their contribution to the wire safety budget.
  const tail = encoder.encode(event("ok"));
  let remaining = size - tail.byteLength;
  const chunks: Uint8Array[] = [];
  while (remaining) {
    const length = Math.min(100_000, remaining);
    assert.ok(length >= 2);
    chunks.push(encoder.encode(":" + "x".repeat(length - 2) + "\n")); remaining -= length;
  }
  chunks.push(tail);
  const deltas: string[] = [];
  t.mock.method(globalThis, "fetch", async () => sse(chunks));
  const work = callTextWithConfig(config, { ...base, timeoutMs: 260, onText: delta => { deltas.push(delta); } });
  if (size === 2_000_000) { assert.equal((await work).text, "ok"); assert.deepEqual(deltas, ["ok"]); }
  else { await assert.rejects(work, /AI_DEADLINE:RESPONSE_TOO_LARGE/); assert.deepEqual(deltas, []); }
});

test("ignored Unicode reasoning consumes UTF-8 wire bytes without becoming generated text", async t => {
  // A character-count wire guard would allow this under-two-million-character, over-two-million-byte body.
  const ignored = encoder.encode('data: {"choices":[{"index":0,"delta":{"reasoning":"' + "я".repeat(90_000) + '"}}]}\n\n');
  let cancellations = 0;
  t.mock.method(globalThis, "fetch", async () => sse([...Array.from({ length: 12 }, () => ignored), encoder.encode(event("ok"))], () => { cancellations++; }));
  const deltas: string[] = [];
  await assert.rejects(callTextWithConfig(config, { ...base, timeoutMs: 260, onText: delta => { deltas.push(delta); } }), /AI_DEADLINE:RESPONSE_TOO_LARGE/);
  assert.deepEqual(deltas, []); assert.equal(cancellations, 1);
});

test("cancellation after retry backoff is scheduled prevents readmission and a second request", async t => {
  // Removing the backoff abort listener would leave the call pending and later re-admit quota.
  const backoff = deferred<void>(), controller = new AbortController(), reason = new Error("USER_CANCELLED");
  const originalTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const timer = originalTimeout(callback, delay, ...args);
    if (delay === 2000) backoff.resolve();
    return timer;
  }) as typeof setTimeout);
  let requests = 0, admissions = 0, starts = 0;
  const reports: AttemptInfo[] = [];
  t.mock.method(globalThis, "fetch", async () => {
    requests++; return new Response("busy", { status: 429, headers: { "retry-after": "2" } });
  });
  const work = callTextWithConfig(config, { ...base, signal: controller.signal,
    beforeAttempt: async () => { admissions++; return true; }, onAttemptStart: () => { starts++; },
    onAttempt: info => { reports.push(info); },
  });
  const rejected = assert.rejects(work, error => error === reason);
  await backoff.promise; controller.abort(reason); await rejected;
  assert.equal(requests, 1); assert.equal(admissions, 1); assert.equal(starts, 1);
  assert.deepEqual(reports.map(({ ok, error }) => ({ ok, error })), [{ ok: false, error: "HTTP 429: провайдер текста недоступен" }]);
});

for (const callback of ["onAttemptStart", "onText", "onAttempt"] as const) {
  test(`${callback} throws fail safely without duplicate external requests`, async t => {
    // Shared GeminiCallOptions already promises safe terminal callback failures; retries can duplicate visible text/spend.
    let requests = 0, admissions = 0;
    const reports: AttemptInfo[] = [];
    t.mock.method(globalThis, "fetch", async () => { requests++; return sse([encoder.encode(event("Готово"))]); });
    const options: GeminiCallOptions = { ...base, beforeAttempt: async () => { admissions++; return true; },
      onText: () => {}, onAttempt: info => { reports.push(info); },
      [callback]: () => { throw new Error("CALLBACK_SECRET_MARKER"); },
    };
    await assert.rejects(callTextWithConfig(config, options), error => error instanceof Error && error.message === "CALLBACK_ERROR");
    assert.equal(requests, callback === "onAttemptStart" ? 0 : 1);
    assert.equal(admissions, 1);
    if (callback === "onText") assert.deepEqual(reports.map(({ ok, error }) => ({ ok, error })), [{ ok: false, error: "CALLBACK_ERROR" }]);
  });
}

test("rejected success telemetry is terminal and is not reported again as a provider failure", async t => {
  let requests = 0;
  const reports: boolean[] = [];
  t.mock.method(globalThis, "fetch", async () => { requests++; return complete(); });
  await assert.rejects(callTextWithConfig(config, { ...base, onAttempt: async info => {
    reports.push(info.ok); throw new Error("ASYNC_CALLBACK_SECRET");
  } }), error => error instanceof Error && error.message === "CALLBACK_ERROR");
  assert.equal(requests, 1); assert.deepEqual(reports, [true]);
});

test("rejected failure telemetry is terminal and hides callback secrets", async t => {
  let requests = 0;
  const reports: boolean[] = [];
  t.mock.method(globalThis, "fetch", async () => { requests++; return new Response("busy", { status: 503 }); });
  await assert.rejects(callTextWithConfig(config, { ...base, onAttempt: async info => {
    reports.push(info.ok); throw new Error("ASYNC_CALLBACK_SECRET");
  } }), error => error instanceof Error && error.message === "CALLBACK_ERROR");
  assert.equal(requests, 1); assert.deepEqual(reports, [false]);
});

const openrouterCatalog = (id: string) => Response.json({ data: [{ id, name: "OpenRouter title", architecture: { input_modalities: ["text"], output_modalities: ["text"] }, supported_parameters: ["structured_outputs"] }] });
const pollinationsCatalog = () => Response.json([{ name: "pollinations/model", title: "Pollinations title", input_modalities: ["text"], output_modalities: ["text"], supported_endpoints: ["/v1/chat/completions"], supported_parameters: ["stream"] }]);

test("public catalog loaders share pending work, isolate providers, clone results and recover at exact TTL", async t => {
  // No module-cache resets or test-only cache API: every observation goes through the public loader/route.
  let now = Date.now(), requests = 0;
  t.mock.method(Date, "now", () => now);
  const upstream = deferred<Response>(), pollinations = deferred<Response>();
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    requests++;
    assert.equal(init?.cache, "no-store"); assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    if (String(url) === "https://openrouter.ai/api/v1/models") return upstream.promise;
    assert.equal(String(url), "https://gen.pollinations.ai/text/models"); return pollinations.promise;
  });
  const first = loadTextModelCatalog("openrouter"), second = loadTextModelCatalog("openrouter");
  const other = loadTextModelCatalog("pollinations");
  assert.equal(requests, 2);
  // Completion time, rather than request-start time, is the beginning of the cache lifetime.
  now += 10_000;
  upstream.resolve(openrouterCatalog("openrouter/original")); pollinations.resolve(pollinationsCatalog());
  const [one, two, isolated] = await Promise.all([first, second, other]);
  assert.deepEqual(one, [{ id: "openrouter/original", name: "OpenRouter title", structuredOutput: true, streaming: true }]);
  assert.deepEqual(isolated, [{ id: "pollinations/model", name: "Pollinations title", structuredOutput: false, streaming: true }]);
  one[0].id = "poisoned"; one.push({ id: "extra", name: "extra", structuredOutput: false, streaming: false });
  assert.equal(two.length, 1); assert.equal(two[0].id, "openrouter/original");
  two[0].name = "poisoned title";
  now += 59_999;
  const cached = await GET(new Request("http://localhost/api/settings/text-provider/models?provider=openrouter"));
  assert.equal(cached.status, 200);
  assert.deepEqual((await cached.json()).models, [{ id: "openrouter/original", name: "OpenRouter title", structuredOutput: true, streaming: true }]);
  assert.equal(requests, 2);

  now += 1;
  const failed = deferred<Response>();
  t.mock.method(globalThis, "fetch", async () => { requests++; return failed.promise; });
  const failOne = loadTextModelCatalog("openrouter"), failTwo = loadTextModelCatalog("openrouter");
  const failures = Promise.allSettled([failOne, failTwo]);
  assert.equal(requests, 3);
  failed.resolve(new Response("CATALOG_SECRET", { status: 503 }));
  for (const result of await failures) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.equal(result.reason.message, "CATALOG_UNAVAILABLE");
  }

  const recovery = deferred<Response>();
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    requests++;
    assert.equal(String(url), "https://openrouter.ai/api/v1/models"); return recovery.promise;
  });
  const recoveredOne = loadTextModelCatalog("openrouter"), recoveredTwo = loadTextModelCatalog("openrouter");
  assert.equal(requests, 4);
  recovery.resolve(openrouterCatalog("openrouter/recovered"));
  assert.deepEqual((await Promise.all([recoveredOne, recoveredTwo])).map(models => models[0].id), ["openrouter/recovered", "openrouter/recovered"]);
  assert.equal((await loadTextModelCatalog("openrouter"))[0].id, "openrouter/recovered");
  assert.equal(requests, 4);

  // Pollinations has independently expired; its failure must leave recovered OpenRouter metadata intact.
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    requests++; assert.equal(String(url), "https://gen.pollinations.ai/text/models"); return new Response("private", { status: 503 });
  });
  await assert.rejects(loadTextModelCatalog("pollinations"), /^Error: CATALOG_UNAVAILABLE$/);
  assert.equal((await loadTextModelCatalog("openrouter"))[0].id, "openrouter/recovered");
  assert.equal(requests, 5);
});
