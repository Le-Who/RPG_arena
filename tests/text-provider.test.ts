import { test } from "node:test";
import assert from "node:assert/strict";
import { callTextWithConfig } from "../src/lib/text-provider";
import { QuotaAdmissionError } from "../src/lib/quota-errors";

const base = { keys: ["gemini-secret"], models: ["selected/model"], system: "system", user: "user" };
const config = { textProvider: "openrouter" as const, textApiKey: "external-secret" };
const success = () => Response.json({ choices: [{ message: { content: "Готово" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 2 }, prompt_tokens_details: { cached_tokens: 3 } } });

test("external providers use fixed endpoints, selected raw model and only configured bearer key", async () => {
  const old = global.fetch;
  try {
    for (const provider of ["openrouter", "pollinations"] as const) {
      let admission = "", logged = "";
      global.fetch = async (url, init) => {
        assert.equal(String(url), provider === "openrouter" ? "https://openrouter.ai/api/v1/chat/completions" : "https://gen.pollinations.ai/v1/chat/completions");
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer external-secret");
        assert.equal(init?.redirect, "error");
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, "selected/model");
        assert.deepEqual(body.messages, [{ role: "system", content: "system" }, { role: "user", content: "user" }]);
        return success();
      };
      const result = await callTextWithConfig({ ...config, textProvider: provider }, { ...base, beforeAttempt: async model => { admission = model; return true; }, onAttempt: info => { logged = info.model; } });
      assert.equal(admission, "selected/model"); assert.equal(logged, admission);
      assert.equal(result.model, admission); assert.equal(result.text, "Готово");
      assert.equal(result.promptTokens, 10); assert.equal(result.completionTokens, 4);
      assert.equal(result.thoughtTokens, 2); assert.equal(result.cachedTokens, 3);
    }
  } finally { global.fetch = old; }
});

test("Gemini default retains its existing key and endpoint contract", async () => {
  const old = global.fetch;
  try {
    global.fetch = async (url, init) => {
      assert.match(String(url), /generativelanguage.googleapis.com/);
      assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "gemini-secret");
      return Response.json({ candidates: [{ content: { parts: [{ text: "Gemini" }] }, finishReason: "STOP" }] });
    };
    assert.equal((await callTextWithConfig({}, base)).text, "Gemini");
  } finally { global.fetch = old; }
});

test("schema conversion preserves constraints and original schema without propertyOrdering", async () => {
  const old = global.fetch;
  const schema = { type: "object", properties: { items: { type: "array", minItems: 1, items: { type: "object", properties: { value: { type: "integer", minimum: 2 } }, required: ["value"], propertyOrdering: ["value"] } } }, required: ["items"], propertyOrdering: ["items"] };
  const before = JSON.stringify(schema);
  try {
    global.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.response_format.type, "json_schema"); assert.equal(body.response_format.json_schema.strict, false);
      const converted = body.response_format.json_schema.schema;
      assert.equal(converted.additionalProperties, undefined); assert.equal(converted.properties.items.items.additionalProperties, undefined);
      assert.equal(converted.properties.items.minItems, 1); assert.equal(converted.properties.items.items.properties.value.minimum, 2);
      assert.equal(JSON.stringify(converted).includes("propertyOrdering"), false);
      assert.equal(body.provider.require_parameters, true);
      assert.equal(body.provider.allow_fallbacks, false);
      return success();
    };
    await callTextWithConfig(config, { ...base, responseSchema: schema });
    assert.equal(JSON.stringify(schema), before);
  } finally { global.fetch = old; }
});

test("partial SSE frames stream only content and collect trailing usage", async () => {
  const old = global.fetch; const deltas: string[] = [];
  try {
    global.fetch = async () => {
      const wire = ': comment\r\ndata: {"choices":[{"delta":{"reasoning":"private","content":"При"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"вет"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":3}}\n\ndata: [DONE]\n\n';
      const bytes = new TextEncoder().encode(wire);
      return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
    };
    const result = await callTextWithConfig(config, { ...base, onText: delta => deltas.push(delta) });
    assert.equal(result.text, "Привет"); assert.deepEqual(deltas, ["При", "вет"]);
    assert.equal(result.promptTokens, 9); assert.equal(result.completionTokens, 3);
  } finally { global.fetch = old; }
});

test("external failure retries only selected model, resets drafts, and re-admits quota", async () => {
  const old = global.fetch; let calls = 0, starts = 0, admissions = 0;
  try {
    global.fetch = async (_url, init) => {
      calls++; assert.equal(JSON.parse(String(init?.body)).model, "selected/model");
      return calls === 1 ? new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', { headers: { "content-type": "text/event-stream" } }) : success();
    };
    const result = await callTextWithConfig(config, { ...base, models: ["selected/model", "hidden-fallback"], onText: () => {}, onAttemptStart: () => { starts++; }, beforeAttempt: async () => { admissions++; return true; } });
    assert.equal(result.text, "Готово"); assert.equal(calls, 2); assert.equal(starts, 2); assert.equal(admissions, 2);
  } finally { global.fetch = old; }
});

test("permanent provider errors and network failures never expose response bodies or secrets", async () => {
  const old = global.fetch; let calls = 0; const errors: string[] = [];
  try {
    global.fetch = async () => { calls++; return Response.json({ error: { message: "external-secret" } }, { status: 401 }); };
    await assert.rejects(() => callTextWithConfig(config, { ...base, onAttempt: info => { if (info.error) errors.push(info.error); } }), /HTTP 401/);
    assert.equal(calls, 1); assert.equal(errors.join().includes("secret"), false);
    global.fetch = async () => { throw new Error("network external-secret"); };
    await assert.rejects(() => callTextWithConfig(config, base), error => error instanceof Error && !error.message.includes("secret"));
  } finally { global.fetch = old; }
});

test("denied quota and failed quota storage fail closed without fetch", async () => {
  const old = global.fetch; let calls = 0;
  try {
    global.fetch = async () => { calls++; return success(); };
    await assert.rejects(() => callTextWithConfig(config, { ...base, beforeAttempt: async () => false }), error => error instanceof QuotaAdmissionError && error.code === "QUOTA_EXHAUSTED" && error.providerAttempts === 0);
    await assert.rejects(() => callTextWithConfig(config, { ...base, beforeAttempt: async () => { throw new QuotaAdmissionError("QUOTA_UNAVAILABLE"); } }), /QUOTA_UNAVAILABLE/);
    assert.equal(calls, 0);
  } finally { global.fetch = old; }
});

test("admission cancellation and deadlines cannot permit a late fetch", async () => {
  const old = global.fetch; let calls = 0; const controller = new AbortController(); let approve!: (value: boolean) => void;
  try {
    global.fetch = async () => { calls++; return success(); };
    const pending = callTextWithConfig(config, { ...base, signal: controller.signal, beforeAttempt: () => new Promise(resolve => { approve = resolve; }) });
    controller.abort();
    await assert.rejects(() => pending, error => error instanceof QuotaAdmissionError && error.code === "QUOTA_ADMISSION_CANCELLED");
    approve(true);
    await assert.rejects(() => callTextWithConfig(config, { ...base, timeoutMs: 260, beforeAttempt: () => new Promise(resolve => setTimeout(() => resolve(true), 300)) }), error => error instanceof QuotaAdmissionError && error.code === "QUOTA_ADMISSION_TIMEOUT");
    assert.equal(calls, 0);
  } finally { global.fetch = old; }
});

test("missing external key never borrows Gemini keys", async () => {
  await assert.rejects(() => callTextWithConfig({ textProvider: "pollinations" }, base), /NO_KEYS/);
});

test("schema conversion preserves a property named propertyOrdering and open maps", async () => {
  const old = global.fetch;
  try {
    global.fetch = async (_url, init) => {
      const schema = JSON.parse(String(init?.body)).response_format.json_schema.schema;
      assert.deepEqual(schema.properties.propertyOrdering, { type: "string" });
      assert.deepEqual(schema.additionalProperties, { type: "string" });
      return success();
    };
    await callTextWithConfig(config, { ...base, responseSchema: { type: "object", properties: { propertyOrdering: { type: "string" } }, additionalProperties: { type: "string" }, propertyOrdering: ["propertyOrdering"] } });
  } finally { global.fetch = old; }
});

test("non-streaming incomplete replies and oversized bodies cannot succeed", async () => {
  const old = global.fetch;
  try {
    for (const finish_reason of [undefined, "length", "content_filter", "tool_calls"]) {
      global.fetch = async () => Response.json({ choices: [{ message: { content: "partial" }, finish_reason }] });
      await assert.rejects(() => callTextWithConfig(config, base), /INCOMPLETE_RESPONSE/);
    }
    global.fetch = async () => Response.json({ choices: [{ message: { content: "x".repeat(200_001) }, finish_reason: "stop" }] });
    await assert.rejects(() => callTextWithConfig(config, base), /RESPONSE_TOO_LARGE/);
    global.fetch = async () => new Response('data: ' + "x".repeat(250_001), { headers: { "content-type": "text/event-stream" } });
    await assert.rejects(() => callTextWithConfig(config, { ...base, onText: () => {} }), /STREAM_FRAME_TOO_LARGE/);
  } finally { global.fetch = old; }
});

test("response-body deadline and caller cancellation close stalled readers", async () => {
  const old = global.fetch; let cancelled = 0;
  try {
    global.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { "content-type": "text/event-stream" } });
    const deadline = callTextWithConfig(config, { ...base, timeoutMs: 260, onText: () => {} });
    // Timeout signals use unref'd timers; keep the isolated test alive until the deadline.
    const alive = setTimeout(() => {}, 400);
    try { await assert.rejects(() => deadline, /AI_DEADLINE:TIMEOUT/); } finally { clearTimeout(alive); }
    assert.equal(cancelled, 1);
    const controller = new AbortController();
    const pending = callTextWithConfig(config, { ...base, signal: controller.signal, onText: () => {} });
    await new Promise(resolve => setImmediate(resolve)); controller.abort(new Error("USER_CANCELLED"));
    await assert.rejects(() => pending, /USER_CANCELLED/);
    assert.equal(cancelled, 2);
  } finally { global.fetch = old; }
});

test("SSE provider errors are sanitized and a denied retry reports prior provider attempts", async () => {
  const old = global.fetch; const errors: string[] = []; let admissions = 0;
  try {
    global.fetch = async () => new Response('data: {"error":{"message":"external-secret"},"choices":[{"delta":{"content":"partial"},"finish_reason":"error"}]}\n\n', { headers: { "content-type": "text/event-stream" } });
    await assert.rejects(() => callTextWithConfig(config, { ...base, onText: () => {}, beforeAttempt: async () => ++admissions === 1, onAttempt: info => { if (info.error) errors.push(info.error); } }), error => error instanceof QuotaAdmissionError && error.code === "QUOTA_EXHAUSTED" && error.providerAttempts === 1);
    assert.deepEqual(errors, ["PROVIDER_STREAM_ERROR"]);
  } finally { global.fetch = old; }
});

test("explicit zero token usage remains zero rather than estimates", async () => {
  const old = global.fetch;
  try {
    global.fetch = async () => Response.json({ choices: [{ message: { content: "cached" }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0 } });
    const result = await callTextWithConfig(config, base);
    assert.equal(result.promptTokens, 0); assert.equal(result.completionTokens, 0);
  } finally { global.fetch = old; }
});
