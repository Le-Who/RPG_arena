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
