import { test } from "node:test";
import assert from "node:assert/strict";
import { callGeminiWithRotation } from "../src/lib/gemini";

const success = () => Response.json({ candidates: [{ content: { parts: [{ text: '{"narration":"Готово"}' }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 8 } });
const base = { keys: ["key-a"], models: ["lite", "flash"], system: "test", user: "test" };
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
