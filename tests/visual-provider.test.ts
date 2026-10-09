import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { fetchFromProvider, type MediaProvider } from "../src/lib/visual-provider";

const provider: MediaProvider = { id: "fixture", defaultModel: "fixture", capabilities: { generate: true, edit: false, referenceInput: false }, buildRequest: () => ({ url: "https://fixture.invalid/image", headers: {} }) };
const request = { prompt: "Кафе", seed: 1, width: 1, height: 1, model: "fixture" };
// A decoded 1×1 RGBA white pixel, independently checked with sharp.raw(): ffffffff.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==", "base64");
async function within<T>(pending: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("TEST_DEADLINE_EXCEEDED")), 500); })]); }
  finally { clearTimeout(timer); }
}

test("visual adapter accepts supported MIME with a valid tiny PNG fixture", async () => {
  const result = await fetchFromProvider(provider, request, async () => new Response(png, { headers: { "Content-Type": "image/png; charset=binary" } }));
  assert.equal(result.mimeType, "image/png"); assert.deepEqual(result.image, png);
});

for (const [headers, status, code] of [
  [{ "Content-Type": "text/html" }, 200, "PROVIDER_NOT_IMAGE"],
  [{ "Content-Type": "image/png", "Content-Length": String(8 * 1024 * 1024 + 1) }, 200, "PROVIDER_BAD_SIZE"],
  [{ "Content-Type": "image/png" }, 429, "PROVIDER_HTTP_429"],
] as const) test(`early ${code} rejection cancels unread image body without waiting for source`, async () => {
  let cancelled = 0;
  const response = new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }), { headers, status });
  await assert.rejects(() => within(fetchFromProvider(provider, request, async () => response)), error => error instanceof Error && error.message === code);
  assert.equal(cancelled, 1); assert.equal(response.body?.locked, false);
});

test("streamed visual bytes reject above 8 MiB and cancel source", async () => {
  let cancelled = 0;
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(8 * 1024 * 1024)); c.enqueue(new Uint8Array(1)); }, cancel() { cancelled++; return new Promise(() => {}); } }), { headers: { "Content-Type": "image/png" } });
  await assert.rejects(() => within(fetchFromProvider(provider, request, async () => response)), /PROVIDER_BAD_SIZE/);
  assert.equal(cancelled, 1); assert.equal(response.body?.locked, false);
});

test("streamed visual byte cap includes the exact 8 MiB boundary", async () => {
  const bytes = new Uint8Array(8 * 1024 * 1024); bytes.set(png);
  const result = await fetchFromProvider(provider, request, async () => new Response(bytes, { headers: { "Content-Type": "image/png" } }));
  assert.equal(result.image.byteLength, 8 * 1024 * 1024);
});

test("visual deadline cancels a stalled post-header body even if cancellation never resolves", async () => {
  const controller = new AbortController(); let reading!: () => void, cancelled = 0;
  const entered = new Promise<void>(resolve => { reading = resolve; });
  const timeout = mock.method(AbortSignal, "timeout", (ms: number) => { assert.equal(ms, 90_000); return controller.signal; });
  try {
    const body = new ReadableStream({ pull() { if (body.locked) reading(); }, cancel() { cancelled++; return new Promise(() => {}); } });
    const response = new Response(body, { headers: { "Content-Type": "image/png" } });
    const pending = fetchFromProvider(provider, request, async () => response);
    await entered; controller.abort(new Error("SYNTHETIC_TIMEOUT_SECRET"));
    await assert.rejects(() => within(pending), error => error instanceof Error && error.message === "PROVIDER_TIMEOUT");
    assert.equal(cancelled, 1); assert.equal(response.body?.locked, false);
  } finally { timeout.mock.restore(); }
});
