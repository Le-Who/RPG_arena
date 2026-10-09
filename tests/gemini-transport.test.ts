import { test } from "node:test";
import assert from "node:assert/strict";
import { callGeminiWithRotation } from "../src/lib/gemini";
import { QuotaAdmissionError } from "../src/lib/quota-errors";

const success = () => Response.json({ candidates: [{ content: { parts: [{ text: '{"narration":"Готово"}' }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 8 } });
const base = { keys: ["key-a"], models: ["lite", "flash"], system: "test", user: "test" };
test("denied admission makes no provider fetch or provider attempt log", async () => {
  const old = global.fetch; let calls = 0, logged = 0;
  try {
    global.fetch = async () => { calls++; return success(); };
    await assert.rejects(() => callGeminiWithRotation({ ...base, beforeAttempt: async () => false, onAttempt: () => { logged++; } }), /QUOTA_EXHAUSTED/);
    assert.equal(calls, 0); assert.equal(logged, 0);
  } finally { global.fetch = old; }
});
test("admission database errors fail closed without provider retry", async () => {
  const old = global.fetch; let calls = 0, reservations = 0;
  try {
    global.fetch = async () => { calls++; return success(); };
    await assert.rejects(() => callGeminiWithRotation({ ...base, beforeAttempt: async () => { reservations++; throw new Error("QUOTA_UNAVAILABLE"); } }), /QUOTA_UNAVAILABLE/);
    assert.equal(calls, 0); assert.equal(reservations, 1);
  } finally { global.fetch = old; }
});
test("stalled quota admission observes cancellation and late approval cannot fetch", async () => {
  const old = global.fetch; let calls = 0;
  const controller = new AbortController(); let approve!: (allowed: boolean) => void;
  try {
    global.fetch = async () => { calls++; return success(); };
    const pending = callGeminiWithRotation({ ...base, signal: controller.signal, beforeAttempt: () => new Promise(resolve => { approve = resolve; }) });
    controller.abort();
    await assert.rejects(() => pending, (error: unknown) =>
      error instanceof QuotaAdmissionError && error.code === "QUOTA_ADMISSION_CANCELLED" && error.providerAttempts === 0);
    approve(true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 0);
  } finally { global.fetch = old; }
});
test("admission time consumes the overall provider deadline", async () => {
  const old = global.fetch; let calls = 0;
  try {
    global.fetch = async () => { calls++; return success(); };
    await assert.rejects(() => callGeminiWithRotation({ ...base, timeoutMs: 260,
      beforeAttempt: async () => { await new Promise(resolve => setTimeout(resolve, 300)); return true; } }), (error: unknown) =>
      error instanceof QuotaAdmissionError && error.code === "QUOTA_ADMISSION_TIMEOUT" && error.providerAttempts === 0);
    assert.equal(calls, 0);
  } finally { global.fetch = old; }
});
test("key-specific 400 still tries the second key on the same model", async () => {
  const old=global.fetch; const calls:string[]=[];
  try {
    global.fetch=async(url,init)=>{calls.push(`${url}:${new Headers(init?.headers).get('x-goog-api-key')}`);return calls.length===1?Response.json({error:{status:'INVALID_ARGUMENT',message:'API key not valid'}},{status:400}):success();};
    const result=await callGeminiWithRotation({...base,keys:['key-a','key-b']});
    assert.equal(result.model,'lite');assert.equal(result.keyIndex,1);
  }finally{global.fetch=old;}
});
test("overload retries same model before falling back, and alternate key comes first", async () => {
  const old = global.fetch;
  try {
    const calls: string[] = [];
    global.fetch = async (url, init) => { calls.push(`${String(url).split('/models/')[1]}:${new Headers(init?.headers).get('x-goog-api-key')}`); return calls.length < 3 ? new Response('', { status: 503 }) : success(); };
    await callGeminiWithRotation({ ...base, keys: ["key-a", "key-b"] });
    assert.deepEqual(calls.map(c => c.split(':').slice(0, 1)[0]), ["lite", "lite", "lite"]);
    assert.deepEqual(calls.map(c => c.split(':').at(-1)), ["key-a", "key-b", "key-a"]);
    calls.length = 0;
    await callGeminiWithRotation(base);
    assert.deepEqual(calls.map(c => c.split(':')[0]), ["lite", "lite", "flash"]);
  } finally { global.fetch = old; }
});
test("stream exposes incremental text, excludes thoughts and measures complete body", async () => {
  const old = global.fetch;
  try {
    const chunks: string[] = [];
    global.fetch = async () => new Response(new ReadableStream({ async start(c) {
      c.enqueue(new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"secret","thought":true},{"text":"Hello "}]}}]}\r\n\r\n'));
      await new Promise(r => setTimeout(r, 35));
      c.enqueue(new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"world"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2}}\n\n'));
      c.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
    const r = await callGeminiWithRotation({ ...base, onText: (text: string) => { chunks.push(text); } });
    assert.equal(r.text, 'Hello world'); assert.deepEqual(chunks, ['Hello ', 'world']); assert.ok(r.latencyMs >= 25);
  } finally { global.fetch = old; }
});
test("truncated streams cannot be committed as successful and attempts reset drafts", async () => {
  const old = global.fetch;
  try {
    let calls = 0, resets = 0;
    global.fetch = async () => { calls++; return calls === 1 ? new Response('data: {"candidates":[{"content":{"parts":[{"text":"unfinished"}]}}]}\n\n', {headers:{'Content-Type':'text/event-stream'}}) : new Response('data: {"candidates":[{"content":{"parts":[{"text":"complete"}]},"finishReason":"STOP"}]}\n\n', {headers:{'Content-Type':'text/event-stream'}}); };
    const r = await callGeminiWithRotation({ ...base, onText: () => {}, onAttemptStart: () => { resets++; } });
    assert.equal(r.text, 'complete'); assert.equal(resets, 2);
  } finally { global.fetch = old; }
});

async function within<T>(pending: Promise<T>, ms = 700): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("TEST_DEADLINE_EXCEEDED")), ms); })]); }
  finally { clearTimeout(timer); }
}

for (const streaming of [false, true]) test(`Gemini ${streaming ? "SSE" : "JSON"} body deadline cancels stalled reads without awaiting cancellation`, async () => {
  const old = global.fetch; let calls = 0, cancelled = 0;
  try {
    global.fetch = async () => { calls++; return new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }), { headers: { "Content-Type": streaming ? "text/event-stream" : "application/json" } }); };
    await assert.rejects(() => within(callGeminiWithRotation({ ...base, models: ["lite"], timeoutMs: 260, ...(streaming ? { onText: () => {} } : {}) })), /AI_DEADLINE:TIMEOUT/);
    assert.equal(calls, 1); assert.equal(cancelled, 1);
  } finally { global.fetch = old; }
});

test("caller cancellation after headers releases reader and hides arbitrary abort reason", async () => {
  const old = global.fetch; let calls = 0, cancelled = 0, entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; }), controller = new AbortController();
  try {
    global.fetch = async () => { calls++; const body = new ReadableStream({ pull() { if (body.locked) entered(); }, cancel() { cancelled++; return new Promise(() => {}); } }); return new Response(body, { headers: { "Content-Type": "text/event-stream" } }); };
    const pending = callGeminiWithRotation({ ...base, signal: controller.signal, onText: () => {} });
    await reading; controller.abort(new Error("SYNTHETIC_ABORT_SECRET"));
    await assert.rejects(() => within(pending), error => error instanceof Error && error.message === "ABORTED");
    assert.equal(calls, 1); assert.equal(cancelled, 1);
  } finally { global.fetch = old; }
});

test("unknown provider messages cannot impersonate HTTP codes or expose key/model markers", async () => {
  const old = global.fetch; const errors: string[] = []; let calls = 0;
  try {
    global.fetch = async () => { calls++; throw new Error("HTTP 401: KEY_MARKER MODEL_MARKER"); };
    await assert.rejects(() => callGeminiWithRotation({ ...base, keys: ["KEY_MARKER"], models: ["MODEL_MARKER"], onAttempt: info => { if (info.error) errors.push(info.error); } }), error => error instanceof Error && error.message === "ALL_MODELS_FAILED:PROVIDER_ERROR");
    assert.deepEqual(errors, ["PROVIDER_ERROR", "PROVIDER_ERROR"]); assert.equal(calls, 2);
  } finally { global.fetch = old; }
});

for (const callback of ["onAttemptStart", "onText", "onAttempt"] as const) test(`${callback} exceptions are safe and cannot trigger extra paid attempts`, async () => {
  const old = global.fetch; let calls = 0;
  try {
    global.fetch = async () => { calls++; return success(); };
    const options = { ...base, [callback]: () => { throw new Error("CALLBACK_KEY_MARKER"); } };
    await assert.rejects(() => callGeminiWithRotation(options), error => error instanceof Error && error.message === "CALLBACK_ERROR");
    assert.equal(calls, callback === "onAttemptStart" ? 0 : 1);
  } finally { global.fetch = old; }
});

test("stalled attempt telemetry shares total deadline after successful generation", async () => {
  const old = global.fetch; let calls = 0;
  try {
    global.fetch = async () => { calls++; return success(); };
    await assert.rejects(() => within(callGeminiWithRotation({ ...base, timeoutMs: 260, onAttempt: () => new Promise(() => {}) })), /AI_DEADLINE:TIMEOUT/);
    assert.equal(calls, 1);
  } finally { global.fetch = old; }
});

for (const streaming of [false, true]) test(`Gemini ${streaming ? "SSE" : "JSON"} preserves explicit zero usage and bounds invalid token counts`, async () => {
  const old = global.fetch;
  try {
    for (const [usage, expected] of [
      [{ promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0, cachedContentTokenCount: 0 }, [0, 0, 0, 0]],
      [{ promptTokenCount: -1, candidatesTokenCount: "3", thoughtsTokenCount: 0.5, cachedContentTokenCount: -1 }, [3, 2, 0, 0]],
      [{ promptTokenCount: 7, candidatesTokenCount: 4, thoughtsTokenCount: 2, cachedContentTokenCount: 1 }, [7, 4, 2, 1]],
    ] as const) {
      const data = { candidates: [{ content: { parts: [{ text: "Hello" }] }, finishReason: "STOP" }], usageMetadata: usage };
      global.fetch = async () => streaming ? new Response(`data: ${JSON.stringify(data)}\n\n`, { headers: { "Content-Type": "text/event-stream" } }) : Response.json(data);
      const result = await callGeminiWithRotation({ ...base, ...(streaming ? { onText: () => {} } : {}) });
      assert.deepEqual([result.promptTokens, result.completionTokens, result.thoughtTokens, result.cachedTokens], expected);
    }
  } finally { global.fetch = old; }
});

test("wire cap includes ignored JSON fields and closes oversized body", async () => {
  const old = global.fetch; let cancelled = 0;
  try {
    global.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify({ ignored: "x".repeat(2_000_001), candidates: [{ content: { parts: [{ text: "ok" }] } }] }))); }, cancel() { cancelled++; } }), { headers: { "Content-Type": "application/json" } });
    await assert.rejects(() => within(callGeminiWithRotation({ ...base, models: ["lite"], timeoutMs: 260 })), /AI_DEADLINE:RESPONSE_TOO_LARGE/);
    assert.equal(cancelled, 1);
  } finally { global.fetch = old; }
});

test("multi-line SSE frame cap accumulates across network chunks and cancels reader", async () => {
  const old = global.fetch; let cancelled = 0;
  try {
    global.fetch = async () => new Response(new ReadableStream({ start(c) { const encoder = new TextEncoder(); c.enqueue(encoder.encode('data: {"ignored":"' + "x".repeat(130_000) + '\n')); c.enqueue(encoder.encode("data: " + "y".repeat(130_000) + '\n')); }, cancel() { cancelled++; } }), { headers: { "Content-Type": "text/event-stream" } });
    await assert.rejects(() => within(callGeminiWithRotation({ ...base, models: ["lite"], timeoutMs: 260, onText: () => {} })), /AI_DEADLINE:STREAM_FRAME_TOO_LARGE/);
    assert.equal(cancelled, 1);
  } finally { global.fetch = old; }
});

test("HTTP error cleanup cannot hold transport open when cancellation never resolves", async () => {
  const old = global.fetch; let calls = 0, cancelled = 0;
  try {
    global.fetch = async () => { calls++; return new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }), { status: 401 }); };
    await assert.rejects(() => within(callGeminiWithRotation({ ...base, models: ["lite"] })), /ALL_MODELS_FAILED:HTTP 401:/);
    assert.equal(calls, 1); assert.equal(cancelled, 1);
  } finally { global.fetch = old; }
});

test("nonstream missing finishReason retains compatibility, unknown finish reason stays safe", async () => {
  const old = global.fetch;
  try {
    global.fetch = async () => Response.json({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    assert.equal((await callGeminiWithRotation(base)).text, "ok");
    global.fetch = async () => Response.json({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "FINISH_SECRET_MARKER" }] });
    await assert.rejects(() => callGeminiWithRotation({ ...base, models: ["lite"] }), /ALL_MODELS_FAILED:INCOMPLETE_RESPONSE:UNKNOWN$/);
  } finally { global.fetch = old; }
});

for (const status of [400, 401, 403, 404, 408, 429, 500, 502, 503, 504]) test(`HTTP ${status} retains key rotation and model fallback policy`, async () => {
  const old = global.fetch; const requests: string[] = [], errors: string[] = [];
  try {
    global.fetch = async (url, init) => {
      const model = String(url).includes("/models/lite:") ? "lite" : "flash";
      requests.push(`${model}:${new Headers(init?.headers).get("x-goog-api-key")}`);
      return model === "lite" ? new Response("BODY_SECRET_SENTINEL", { status }) : success();
    };
    const result = await callGeminiWithRotation({ ...base, keys: ["key-a", "key-b"], onAttempt: info => { if (info.error) errors.push(info.error); } });
    const expected = status === 404 ? ["lite:key-a", "flash:key-a"] : [400, 401, 403].includes(status) ? ["lite:key-a", "lite:key-b", "flash:key-a"] : ["lite:key-a", "lite:key-b", "lite:key-a", "lite:key-b", "flash:key-a"];
    assert.equal(result.model, "flash"); assert.deepEqual(requests, expected);
    assert.ok(errors.every(error => error === `HTTP ${status}: Gemini временно недоступен`));
  } finally { global.fetch = old; }
});

test("Retry-After exceeding remaining budget prevents another Gemini attempt", async () => {
  const old = global.fetch; let calls = 0;
  try {
    global.fetch = async () => { calls++; return new Response("", { status: 429, headers: { "Retry-After": "100" } }); };
    await assert.rejects(() => callGeminiWithRotation({ ...base, keys: ["key-a"], models: ["lite"], timeoutMs: 700 }), /AI_DEADLINE:HTTP 429:/);
    assert.equal(calls, 1);
  } finally { global.fetch = old; }
});

test("attempt-start callback follows admission and denied models never reset emitted text", async () => {
  const old = global.fetch; const events: string[] = [];
  try {
    global.fetch = async () => { events.push("fetch"); return success(); };
    const result = await callGeminiWithRotation({ ...base, beforeAttempt: async model => { events.push(`admit:${model}`); return model === "flash"; }, onAttemptStart: () => { events.push("start"); } });
    assert.equal(result.model, "flash"); assert.deepEqual(events, ["admit:lite", "admit:flash", "start", "fetch"]);
  } finally { global.fetch = old; }
});

test("invalid JSON cannot expose parser body snippets in attempt telemetry", async () => {
  const old = global.fetch; const errors: string[] = [];
  try {
    global.fetch = async () => new Response('{"SECRET_BODY_SENTINEL":', { headers: { "Content-Type": "application/json" } });
    await assert.rejects(() => callGeminiWithRotation({ ...base, models: ["lite"], onAttempt: info => { if (info.error) errors.push(info.error); } }), /ALL_MODELS_FAILED:INVALID_RESPONSE$/);
    assert.deepEqual(errors, ["INVALID_RESPONSE", "INVALID_RESPONSE"]);
  } finally { global.fetch = old; }
});

test("deadline reports one failed provider attempt without awaiting a stalled failure logger", async () => {
  const old = global.fetch; const attempts: { ok: boolean; error?: string }[] = []; let calls = 0;
  try {
    global.fetch = async () => { calls++; return new Response(new ReadableStream(), { headers: { "Content-Type": "application/json" } }); };
    await assert.rejects(() => within(callGeminiWithRotation({ ...base, timeoutMs: 260, onAttempt: info => { attempts.push(info); return new Promise(() => {}); } })), /AI_DEADLINE:TIMEOUT/);
    assert.equal(calls, 1); assert.deepEqual(attempts.map(({ ok, error }) => ({ ok, error })), [{ ok: false, error: "TIMEOUT" }]);
  } finally { global.fetch = old; }
});

test("caller cancellation records a safe failed attempt once and catches logger rejection", async () => {
  const old = global.fetch, controller = new AbortController(); const attempts: { ok: boolean; error?: string }[] = [];
  let entered!: () => void; const reading = new Promise<void>(resolve => { entered = resolve; });
  try {
    global.fetch = async () => { const body = new ReadableStream({ pull() { if (body.locked) entered(); } }); return new Response(body); };
    const pending = callGeminiWithRotation({ ...base, signal: controller.signal, onAttempt: info => { attempts.push(info); return Promise.reject(new Error("LOGGER_SECRET_SENTINEL")); } });
    await reading; controller.abort(new Error("ABORT_SECRET_SENTINEL"));
    await assert.rejects(() => within(pending), error => error instanceof Error && error.message === "ABORTED");
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(attempts.map(({ ok, error }) => ({ ok, error })), [{ ok: false, error: "ABORTED" }]);
  } finally { global.fetch = old; }
});

test("telemetry deadline does not duplicate an already reported successful attempt", async () => {
  const old = global.fetch; const attempts: boolean[] = [];
  try {
    global.fetch = async () => success();
    await assert.rejects(() => within(callGeminiWithRotation({ ...base, timeoutMs: 260, onAttempt: info => { attempts.push(info.ok); return new Promise(() => {}); } })), /AI_DEADLINE:TIMEOUT/);
    assert.deepEqual(attempts, [true]);
  } finally { global.fetch = old; }
});

test("response arriving after fetch deadline releases its unread body", async () => {
  const old = global.fetch; let release!: (response: Response) => void, cancelled = 0;
  try {
    global.fetch = () => new Promise(resolve => { release = resolve; });
    await assert.rejects(() => within(callGeminiWithRotation({ ...base, timeoutMs: 260 })), /AI_DEADLINE:TIMEOUT/);
    release(new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } })));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancelled, 1);
  } finally { global.fetch = old; }
});
