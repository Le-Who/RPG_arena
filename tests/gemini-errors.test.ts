import test from "node:test";
import assert from "node:assert/strict";
import { readGeminiHttpError, geminiFailureMessage } from "../src/lib/gemini-errors";

function errorBody(reason: unknown, status: unknown = "INVALID_ARGUMENT") {
  return { error: { status, message: "SECRET_MESSAGE_SENTINEL кириллица", details: [
    { "@type": "type.googleapis.com/google.rpc.LocalizedMessage", message: "SECRET_LOCALIZED_SENTINEL" },
    { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, metadata: { consumer: "SECRET_PROJECT_SENTINEL", key: "SECRET_KEY_SENTINEL" } },
  ] } };
}

test("Gemini diagnostics use allowlisted ErrorInfo reasons before the general status", async () => {
  for (const reason of ["API_KEY_INVALID", "API_KEY_EXPIRED", "API_KEY_SERVICE_BLOCKED", "API_KEY_HTTP_REFERRER_BLOCKED", "API_KEY_IP_ADDRESS_BLOCKED", "SERVICE_DISABLED", "BILLING_DISABLED", "RATE_LIMIT_EXCEEDED"]) {
    assert.equal(await readGeminiHttpError(Response.json(errorBody(reason), { status: 400 })), `HTTP 400: ${reason}`);
  }
});

test("unknown reason and status values, messages and metadata cannot escape the diagnostic boundary", async () => {
  for (const [body, expected] of [
    [errorBody("SECRET_REASON_SENTINEL"), "INVALID_ARGUMENT"],
    [errorBody("SECRET_REASON_SENTINEL", "SECRET_STATUS_SENTINEL"), "UNKNOWN"],
    [{ error: { message: "API_KEY_INVALID SECRET_MESSAGE_SENTINEL" } }, "UNKNOWN"],
    [{ error: { status: "FAILED_PRECONDITION", details: [{ "@type": "unknown-type", reason: "API_KEY_INVALID" }] } }, "FAILED_PRECONDITION"],
    [{ error: { status: "PERMISSION_DENIED", details: { reason: "API_KEY_INVALID" } } }, "PERMISSION_DENIED"],
    [{ error: { status: "INVALID_ARGUMENT", details: [null, "API_KEY_INVALID", { reason: "API_KEY_INVALID" }] } }, "INVALID_ARGUMENT"],
    [null, "UNKNOWN"], [[], "UNKNOWN"], [{ error: ["API_KEY_INVALID"] }, "UNKNOWN"],
  ] as const) assert.equal(await readGeminiHttpError(Response.json(body, { status: 400 })), `HTTP 400: ${expected}`);
  assert.equal(await readGeminiHttpError(new Response("<html>SECRET_BODY_SENTINEL</html>", { status: 502 })), "HTTP 502: UNKNOWN");
  assert.equal(await readGeminiHttpError(new Response(null, { status: 403 })), "HTTP 403: UNKNOWN");
});

test("Gemini diagnostic body decoding supports split UTF8 but cancels oversized wire bodies", { timeout: 1500 }, async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(errorBody("API_KEY_INVALID")));
  const split = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  assert.equal(await readGeminiHttpError(new Response(split, { status: 400 })), "HTTP 400: API_KEY_INVALID");
  let cancelled = 0;
  const large = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ ...errorBody("API_KEY_INVALID"), ignored: "я".repeat(9_000) })));
  }, cancel() { cancelled++; return new Promise<void>(() => {}); } });
  assert.equal(await readGeminiHttpError(new Response(large, { status: 400 })), "HTTP 400: UNKNOWN");
  assert.equal(cancelled, 1);
});

test("Gemini diagnostic reads and cancellation cannot wait indefinitely for an error body", { timeout: 1500 }, async () => {
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled++; return new Promise<void>(() => {}); } });
  assert.equal(await readGeminiHttpError(new Response(body, { status: 401 })), "HTTP 401: UNKNOWN");
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});

test("Gemini diagnostics obey caller cancellation without exposing its reason", { timeout: 1500 }, async () => {
  for (const alreadyAborted of [false, true]) {
    const controller = new AbortController();
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled++; return new Promise<void>(() => {}); } });
    if (alreadyAborted) controller.abort(new Error("SECRET_ABORT_SENTINEL"));
    const reading = readGeminiHttpError(new Response(body, { status: 400 }), controller.signal);
    if (!alreadyAborted) controller.abort(new Error("SECRET_ABORT_SENTINEL"));
    assert.equal(cancelled, 1, "caller cancellation releases the body immediately, before the 250 ms diagnostic timeout");
    assert.equal(await reading, "HTTP 400: UNKNOWN");
    assert.equal(cancelled, 1);
    assert.equal(body.locked, false);
  }
});

test("client copy distinguishes confirmed key failures from rejected requests, access, prerequisites and quota", () => {
  for (const [diagnostic, expected] of [
    ["HTTP 400: API_KEY_INVALID", /новый ключ.*настройках/],
    ["ALL_MODELS_FAILED:HTTP 400: API_KEY_EXPIRED", /истёк.*новый ключ/],
    ["HTTP 403: API_KEY_SERVICE_BLOCKED", /ограничения ключа/],
    ["HTTP 403: PERMISSION_DENIED", /разрешения.*ключа/],
    ["HTTP 400: FAILED_PRECONDITION", /услови.*проекта/],
    ["HTTP 400: INVALID_ARGUMENT", /параметры запроса/],
    ["HTTP 400: UNKNOWN", /HTTP 400.*причин/i],
    ["HTTP 401: UNKNOWN", /авторизац/],
    ["HTTP 402: RESOURCE_EXHAUSTED", /баланс/],
    ["HTTP 429: RESOURCE_EXHAUSTED", /лимит/],
    ["AI_DEADLINE:HTTP 429: UNKNOWN", /лимит/],
    ["HTTP 504: DEADLINE_EXCEEDED", /вовремя/],
    ["AI_DEADLINE:TIMEOUT", /вовремя/],
    ["HTTP 503: UNAVAILABLE", /временно/],
  ] as const) assert.match(geminiFailureMessage(diagnostic) ?? "", expected, diagnostic);

  for (const unsafe of ["HTTP 400: API_KEY_INVALID SECRET", "HTTP 400: SECRET_REASON_SENTINEL", "raw API_KEY_INVALID", "SECRET_PREFIX:HTTP 400: API_KEY_INVALID", "AI_DEADLINE:SECRET", "HTTP 400: API_KEY_INVALID\n", "ALL_MODELS_FAILED:HTTP 400: API_KEY_INVALID\nSECRET"]) {
    assert.equal(geminiFailureMessage(unsafe), null, unsafe);
  }
});
