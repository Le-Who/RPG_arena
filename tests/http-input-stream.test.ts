import test from "node:test";
import assert from "node:assert/strict";
import { HttpError, readJsonObject } from "../src/lib/http";

test("oversized JSON rejects promptly even while request-stream cancellation remains pending", async () => {
  let cancellations = 0, release!: () => void;
  const cancelled = new Promise<void>(resolve => { release = resolve; });
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(17)); },
    cancel() { cancellations++; return cancelled; },
  });
  const request = new Request("https://app.test/api", { method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half" } as RequestInit);
  const work = readJsonObject(request, 16);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("TEST_DEADLINE_EXCEEDED")), 200);
    })]), error => error instanceof HttpError && error.status === 413 && error.code === "BODY_TOO_LARGE");
    assert.equal(cancellations, 1);
    assert.equal(request.body?.locked, false);
  } finally { clearTimeout(timer); release(); await work.catch(() => {}); }
});

test("JSON media type validation rejects prefix lookalikes and accepts parameters", async () => {
  for (const contentType of ["application/jsonp", "application/json-seq", "application/json-invalid"]) {
    const request = new Request("https://app.test/api", { method: "POST", headers: { "content-type": contentType }, body: '{}' });
    await assert.rejects(readJsonObject(request), error => error instanceof HttpError && error.status === 415);
    assert.equal(request.bodyUsed, false);
  }
  assert.deepEqual(await readJsonObject(new Request("https://app.test/api", {
    method: "POST", headers: { "content-type": "Application/JSON ; charset=utf-8" }, body: '{"valid":true}',
  })), { valid: true });
});
