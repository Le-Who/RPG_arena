import test from "node:test";
import assert from "node:assert/strict";
import { callGeminiWithRotation } from "../src/lib/gemini-transport";
import { callTextWithConfig } from "../src/lib/text-provider";
import { QuotaAdmissionError } from "../src/lib/quota-errors";

const options = { keys: ["synthetic-key"], models: ["synthetic-model"], system: "test", user: "test" };
const providers = ["gemini", "openrouter", "pollinations"] as const;

function call(provider: typeof providers[number], extra: Parameters<typeof callGeminiWithRotation>[0]) {
  return provider === "gemini" ? callGeminiWithRotation(extra)
    : callTextWithConfig({ textProvider: provider, textApiKey: "synthetic-key" }, extra);
}

async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("ADMISSION_DID_NOT_SETTLE")), 500);
    })]);
  } finally { clearTimeout(timer); }
}

for (const provider of providers) test(`${provider}: synchronous cancellation inside admission cannot leave the request pending`, async t => {
  const controller = new AbortController(); let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => { fetches++; throw new Error("unexpected provider request"); });
  const pending = call(provider, { ...options, signal: controller.signal, beforeAttempt: () => {
    controller.abort(new Error("synthetic cancellation"));
    return new Promise<boolean>(() => {});
  } });
  await assert.rejects(() => bounded(pending), error => error instanceof QuotaAdmissionError
    && error.code === "QUOTA_ADMISSION_CANCELLED" && error.providerAttempts === 0);
  assert.equal(fetches, 0);
});

for (const provider of providers) test(`${provider}: admission that cancels and throws is contained without an unhandled rejection`, async t => {
  const controller = new AbortController(); let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => { fetches++; throw new Error("unexpected provider request"); });
  await assert.rejects(() => call(provider, { ...options, signal: controller.signal, beforeAttempt: () => {
    controller.abort(new Error("synthetic cancellation"));
    throw new Error("synthetic admission failure");
  } }), error => error instanceof QuotaAdmissionError && error.code === "QUOTA_ADMISSION_CANCELLED");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(fetches, 0);
});

function payload(provider: typeof providers[number], text: string, streaming: boolean): string {
  const data = provider === "gemini"
    ? { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] }
    : { choices: [{ ...(streaming ? { delta: { content: text } } : { message: { content: text } }), finish_reason: "stop" }] };
  return streaming ? `data: ${JSON.stringify(data)}\n\n` : JSON.stringify(data);
}

for (const provider of providers) for (const streaming of [false, true]) {
  test(`${provider} ${streaming ? "SSE" : "JSON"}: malformed UTF-8 is rejected and the clean retry is returned`, async t => {
    const errors: string[] = []; let fetches = 0;
    const malformed = Buffer.from(payload(provider, "broken_MARKER_text", streaming));
    malformed[malformed.indexOf("MARKER")] = 0xff;
    t.mock.method(globalThis, "fetch", async () => {
      fetches++;
      return new Response(fetches === 1 ? malformed : payload(provider, "Исправный ответ", streaming), {
        headers: { "content-type": streaming ? "text/event-stream" : "application/json" },
      });
    });
    const result = await call(provider, { ...options, ...(streaming ? { onText: () => {} } : {}),
      onAttempt: info => { if (info.error) errors.push(info.error); },
    });
    assert.equal(result.text, "Исправный ответ");
    assert.equal(fetches, 2);
    assert.deepEqual(errors, ["INVALID_RESPONSE"]);
  });

  test(`${provider} ${streaming ? "SSE" : "JSON"}: UTF-8 code points split across chunks remain intact`, async t => {
    const text = "Встреча у кафе 🌿";
    const bytes = Buffer.from(payload(provider, text, streaming));
    t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
    }), { headers: { "content-type": streaming ? "text/event-stream" : "application/json" } }));
    const result = await call(provider, { ...options, ...(streaming ? { onText: () => {} } : {}) });
    assert.equal(result.text, text);
  });
}
