import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { fetchFromProvider, PROVIDERS } from "../src/lib/visual-provider";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==", "base64");
const request = { prompt: "Чай в кафе", seed: 42, width: 1024, height: 576, model: "fixture/image", endpoint: "fixture-provider", outputFormat: "png" as const };
const response = (item: unknown) => Response.json({ data: [item] });

test("OpenRouter image adapter pins the saved endpoint and sends one personal-key JSON request", async () => {
  const provider = PROVIDERS.openrouter;
  assert.ok(provider, "OpenRouter image adapter exists");
  let calls = 0;
  const result = await fetchFromProvider(provider, request, async (url, init) => {
    calls++;
    assert.equal(url, "https://openrouter.ai/api/v1/images");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-personal-router");
    assert.deepEqual(JSON.parse(String(init?.body)), { model: "fixture/image", prompt: "Чай в кафе", size: "1024x576", seed: 42, n: 1, output_format: "png", provider: { only: ["fixture-provider"], allow_fallbacks: false } });
    return response({ b64_json: png.toString("base64"), media_type: "image/png" });
  }, "synthetic-personal-router");
  assert.deepEqual(result, { image: png, mimeType: "image/png" });
  assert.equal(calls, 1);
  assert.throws(() => provider.buildRequest(request), /OPENROUTER_KEY_REQUIRED/);
  assert.throws(() => provider.buildRequest({ ...request, endpoint: null }, "synthetic"), /OPENROUTER_ENDPOINT_REQUIRED/);
});

test("OpenRouter image adapter infers missing raster MIME and rejects spoofed MIME, SVG, malformed base64 and URL-only output", async () => {
  const provider = PROVIDERS.openrouter;
  assert.ok(provider, "OpenRouter image adapter exists");
  assert.equal((await fetchFromProvider(provider, request, async () => response({ b64_json: png.toString("base64") }), "synthetic")).mimeType, "image/png");
  for (const item of [
    { b64_json: Buffer.from("<svg/>").toString("base64"), media_type: "image/svg+xml" },
    { b64_json: png.toString("base64"), media_type: "image/jpeg" },
    { b64_json: "!!!not-base64!!!", media_type: "image/png" },
    { url: "http://127.0.0.1/private", media_type: "image/png" },
  ]) {
    let calls = 0;
    await assert.rejects(fetchFromProvider(provider, request, async () => { calls++; return response(item); }, "synthetic"), /PROVIDER_NOT_IMAGE/);
    assert.equal(calls, 1, "output URLs must never cause a second fetch");
  }
});

test("OpenRouter enforces encoded/decoded byte limits before allocating arbitrary output", async () => {
  const provider = PROVIDERS.openrouter;
  assert.ok(provider, "OpenRouter image adapter exists");
  await assert.rejects(fetchFromProvider(provider, request, async () => response({ b64_json: Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64"), media_type: "image/png" }), "synthetic"), /PROVIDER_BAD_SIZE/);
  let cancelled = 0;
  const huge = new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }), { headers: { "Content-Type": "application/json", "Content-Length": String(12 * 1024 * 1024) } });
  await assert.rejects(fetchFromProvider(provider, request, async () => huge, "synthetic"), /PROVIDER_BAD_SIZE/);
  assert.equal(cancelled, 1);
});

test("OpenRouter JSON bodies obey the same 90-second deadline without waiting for cancellation", async () => {
  const provider = PROVIDERS.openrouter;
  assert.ok(provider, "OpenRouter image adapter exists");
  const controller = new AbortController();
  const timeout = mock.method(AbortSignal, "timeout", (ms: number) => { assert.equal(ms, 90_000); return controller.signal; });
  let entered!: () => void, cancelled = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  try {
    const stream = new ReadableStream({ pull() { if (stream.locked) entered(); }, cancel() { cancelled++; return new Promise(() => {}); } });
    const pending = fetchFromProvider(provider, request, async () => new Response(stream, { headers: { "Content-Type": "application/json" } }), "synthetic");
    await started;
    controller.abort();
    await assert.rejects(pending, /PROVIDER_TIMEOUT/);
    assert.equal(cancelled, 1);
  } finally { timeout.mock.restore(); }
});
