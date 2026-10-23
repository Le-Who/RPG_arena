import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readResponseJson } from "../scripts/lib/read-response-json";

test("evaluation JSON reader retains its deadline and cancels a partial body during forced GC", async () => {
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--expose-gc", "--import", "tsx", "--import", "./tests/helpers/test-environment.ts", "./tests/helpers/eval-json-deadline-worker.ts"], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "", bodyTimer: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => { child.kill(); reject(new Error(`worker did not reach body: ${output}`)); }, 10000);
      child.stdout.on("data", bytes => {
        output += String(bytes);
        if (!bodyTimer && output.includes("HEADERS_RECEIVED")) bodyTimer = setTimeout(() => { child.kill(); }, 2000);
      });
      child.stderr.on("data", bytes => { output += String(bytes); });
      child.on("error", error => { clearTimeout(timer); clearTimeout(bodyTimer); reject(error); });
      child.on("close", code => { clearTimeout(timer); clearTimeout(bodyTimer); resolve({ code, output }); });
    });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /HEADERS_RECEIVED/);
    assert.match(result.output, /TimeoutError|AbortError/);
    assert.match(result.output, /BODY_CANCELLED/);
    assert.doesNotMatch(result.output, /UNEXPECTED_SUCCESS|synthetic-body/);
});

test("evaluation JSON reader preserves a complete payload", async () => {
  assert.deepEqual(await readResponseJson(Response.json({ values: [1, 2, 3] }), AbortSignal.timeout(200)), { values: [1, 2, 3] });
});

test("evaluation JSON reader rejects oversized advertised bodies before reading and cancels them", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(Buffer.from("{}")); controller.close(); },
    cancel() { cancelled = true; return new Promise<void>(() => {}); },
  }, { highWaterMark: 0 }), { headers: { "content-length": "2000001" } });
  await assert.rejects(() => readResponseJson(response, AbortSignal.timeout(1000)), /RESPONSE_TOO_LARGE/);
  assert.equal(cancelled, true);
  assert.equal(response.body!.locked, false);
});

test("evaluation JSON reader measures wire bytes at the exact limit and cancels an unadvertised overflow", async () => {
  const body = Buffer.from(JSON.stringify({ text: "я".repeat(999_994) }));
  assert.equal(body.byteLength, 1_999_999);
  assert.equal((await readResponseJson(new Response(Buffer.concat([body, Buffer.from(" ")])), AbortSignal.timeout(2000)) as { text: string }).text.length, 999_994);
  let cancelled = false, chunk = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunk++ === 0) controller.enqueue(body);
      else if (chunk === 2) controller.enqueue(Buffer.from("  "));
      else controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }));
  await assert.rejects(() => readResponseJson(response, AbortSignal.timeout(1000)), /RESPONSE_TOO_LARGE/);
  assert.equal(cancelled, true);
  assert.equal(response.body!.locked, false);
});

test("evaluation JSON reader rejects corrupt UTF-8 but preserves code points split across reads", async () => {
  await assert.rejects(() => readResponseJson(new Response(Uint8Array.from([123, 34, 120, 34, 58, 34, 255, 34, 125])), AbortSignal.timeout(200)), TypeError);
  const bytes = Buffer.from('{"text":"Привет 🌿"}');
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
  }));
  assert.deepEqual(await readResponseJson(response, AbortSignal.timeout(200)), { text: "Привет 🌿" });
});
