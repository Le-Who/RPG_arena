import test from "node:test";
import assert from "node:assert/strict";
import { fetchPollinationsImageModels } from "../src/lib/visual-models";

test("declared oversized image catalogues cancel the unread upstream response", async () => {
  let cancelled = 0;
  const response = new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { "content-length": "524289" } });
  await assert.rejects(fetchPollinationsImageModels(async () => response), /POLLINATIONS_CATALOG_TOO_LARGE/);
  assert.equal(cancelled, 1);
});

test("streamed oversized image catalogues cancel the remaining upstream response", async () => {
  let cancelled = 0;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(524289)); },
    cancel() { cancelled++; },
  }));
  await assert.rejects(fetchPollinationsImageModels(async () => response), /POLLINATIONS_CATALOG_TOO_LARGE/);
  assert.equal(cancelled, 1);
});

test("image catalogue deadline cancels a stalled body after headers", async t => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => controller.signal);
  let cancelled = 0, stream!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream({
    start(value) { stream = value; }, cancel() { cancelled++; },
  }));
  const pending = fetchPollinationsImageModels(async () => response);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  const result = await Promise.race([
    pending.then(() => "resolved", error => (error as Error).message),
    new Promise<string>(resolve => setTimeout(() => resolve("STILL_PENDING"), 100)),
  ]);
  if (result === "STILL_PENDING") stream.close();
  await pending.catch(() => {});
  assert.equal(result, "POLLINATIONS_CATALOG_UNAVAILABLE");
  assert.equal(cancelled, 1);
});
