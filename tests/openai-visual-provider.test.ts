import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { fetchFromProvider, PROVIDERS, visualConfig } from "../src/lib/visual-provider";
import { HttpError } from "../src/lib/http";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==", "base64");
const request = { prompt: "Чай в кафе", seed: 42, width: 1024, height: 576, model: "gpt-image-2.5-flare" };
const response = (item: unknown) => Response.json({ created: 1793318400, data: [item], output_format: "png", size: "1536x1024", quality: "medium" });

test("OpenAI sends one direct personal-key PNG generation with supported dimensions and no seed", async () => {
  const provider = PROVIDERS.openai;
  assert.ok(provider, "OpenAI image adapter exists");
  let calls = 0;
  const result = await fetchFromProvider(provider, { ...request, endpoint: "https://invalid.example", outputFormat: "jpeg" }, async (url, init) => {
    calls++;
    assert.equal(url, "https://api.openai.com/v1/images/generations");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-personal-openai");
    assert.deepEqual(JSON.parse(String(init?.body)), { model: "gpt-image-2.5-flare", prompt: "Чай в кафе", size: "1536x1024", n: 1, output_format: "png" });
    return response({ b64_json: png.toString("base64") });
  }, " synthetic-personal-openai ");
  assert.deepEqual(result, { image: png, mimeType: "image/png" });
  assert.equal(calls, 1);
});

test("OpenAI maps and exposes matching square, landscape and portrait dimensions for persistence", async () => {
  const provider = PROVIDERS.openai;
  assert.ok(provider, "OpenAI image adapter exists");
  const { normalizeOpenAIImageDimensions } = await import("../src/lib/visual-provider");
  assert.equal(typeof normalizeOpenAIImageDimensions, "function");
  assert.deepEqual(normalizeOpenAIImageDimensions(1024, 1024), { width: 1024, height: 1024 });
  assert.deepEqual(normalizeOpenAIImageDimensions(1024, 576), { width: 1536, height: 1024 });
  assert.deepEqual(normalizeOpenAIImageDimensions(576, 1024), { width: 1024, height: 1536 });
  for (const [width, height, size] of [[1024, 1024, "1024x1024"], [1024, 576, "1536x1024"], [576, 1024, "1024x1536"]] as const) {
    const result = provider.buildRequest({ ...request, model: "gpt-image-1-mini", width, height }, "synthetic");
    assert.equal(JSON.parse(result.body!).size, size);
  }
});

test("OpenAI missing personal keys never select an environment key or an application payer", async () => {
  const provider = PROVIDERS.openai;
  assert.ok(provider, "OpenAI image adapter exists");
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "synthetic-application-key-must-not-be-used";
  let calls = 0;
  try {
    for (const key of [undefined, "", "   "]) {
      await assert.rejects(fetchFromProvider(provider, request, async () => { calls++; return response({ b64_json: png.toString("base64") }); }, key), /OPENAI_KEY_REQUIRED/);
    }
    assert.equal(calls, 0);
    assert.equal(visualConfig().provider.id, "pollinations");
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test("OpenAI rejects unsupported, retired and malformed models before a paid request", async () => {
  const provider = PROVIDERS.openai;
  assert.ok(provider, "OpenAI image adapter exists");
  let calls = 0;
  for (const model of ["gpt-image-1", "dall-e-2", "dall-e-3", "gpt-6-astra", "openai/gpt-image-2", "https://invalid.example", "gpt-image-2\n", ""]) {
    await assert.rejects(fetchFromProvider(provider, { ...request, model }, async () => { calls++; return response({ b64_json: png.toString("base64") }); }, "synthetic"), (error: unknown) => error instanceof HttpError && error.status === 400 && error.code === "IMAGE_MODEL_INCOMPATIBLE");
  }
  assert.equal(calls, 0);
});

test("OpenAI decodes only bounded single-image raster data without following output URLs", async () => {
  const provider = PROVIDERS.openai;
  assert.ok(provider, "OpenAI image adapter exists");
  for (const payload of [
    { data: [{ url: "http://127.0.0.1/private" }] },
    { data: [{ b64_json: "!!!" }] },
    { data: [{ b64_json: Buffer.from("<svg/>").toString("base64") }] },
    { data: [{ b64_json: png.toString("base64"), media_type: "image/jpeg" }] },
    { data: [{ b64_json: png.toString("base64") }, { b64_json: png.toString("base64") }] },
  ]) {
    let calls = 0;
    await assert.rejects(fetchFromProvider(provider, request, async () => { calls++; return Response.json(payload); }, "synthetic"), /PROVIDER_NOT_IMAGE/);
    assert.equal(calls, 1);
  }
  let cancelled = 0;
  const huge = new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }), { headers: { "Content-Type": "application/json", "Content-Length": String(12 * 1024 * 1024) } });
  await assert.rejects(fetchFromProvider(provider, request, async () => huge, "synthetic"), /PROVIDER_BAD_SIZE/);
  assert.equal(cancelled, 1);
});

test("OpenAI failures expose stable status codes without provider error text or credentials", async () => {
  const provider = PROVIDERS.openai;
  assert.ok(provider, "OpenAI image adapter exists");
  const secret = "synthetic-invalid-key-must-not-appear";
  const logged: unknown[][] = [];
  const logging = mock.method(console, "error", (...values: unknown[]) => { logged.push(values); });
  try {
    for (const [status, code] of [[400, "OPENAI_REQUEST_REJECTED"], [401, "OPENAI_AUTH_FAILED"], [403, "OPENAI_ACCESS_DENIED"], [404, "OPENAI_MODEL_UNAVAILABLE"], [429, "OPENAI_RATE_LIMITED"], [500, "PROVIDER_HTTP_500"]] as const) {
      let cancelled = 0;
      const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: { message: `Invalid key ${secret}` } }))); }, cancel() { cancelled++; return new Promise(() => {}); } });
      await assert.rejects(fetchFromProvider(provider, request, async () => new Response(body, { status, headers: { "Content-Type": "application/json" } }), secret), (error: unknown) => error instanceof Error && error.message === code && !error.stack?.includes(secret));
      assert.equal(cancelled, 1);
    }
    await assert.rejects(fetchFromProvider(provider, request, async () => { throw new Error(`Transport rejected ${secret}`); }, secret), { message: "PROVIDER_ERROR" });
    assert.deepEqual(logged, []);
  } finally { logging.mock.restore(); }
});

test("OpenAI JSON decoding preserves the bounded deadline and cancels stalled reads", async () => {
  const provider = PROVIDERS.openai;
  assert.ok(provider, "OpenAI image adapter exists");
  const { visualProviderTimeoutMs } = await import("../src/lib/visual-provider");
  assert.equal(typeof visualProviderTimeoutMs, "function");
  assert.equal(visualProviderTimeoutMs("openai"), 150_000);
  assert.equal(visualProviderTimeoutMs("openrouter"), 90_000);
  assert.equal(visualProviderTimeoutMs("pollinations"), 90_000);
  const controller = new AbortController();
  const timeout = mock.method(AbortSignal, "timeout", (ms: number) => { assert.equal(ms, 150_000); return controller.signal; });
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

test("OpenAI catalog offers documented image models, excludes retired models and protects its allowlist", async () => {
  assert.ok(PROVIDERS.openai, "OpenAI image adapter exists");
  const { loadOpenAIImageModels, assertOpenAIImageModel, OPENAI_IMAGE_DEFAULT_MODEL } = await import("../src/lib/openai-image-catalog");
  const catalog = await loadOpenAIImageModels();
  assert.ok(catalog.models.some(model => model.id === OPENAI_IMAGE_DEFAULT_MODEL));
  for (const model of catalog.models) {
    assert.equal(model.generationSupported, true);
    assert.doesNotThrow(() => assertOpenAIImageModel(model.id));
    assert.equal(model.price?.complete, false, "variable or unknown prices are not a fixed image total");
  }
  for (const retired of ["gpt-image-1", "dall-e-2", "dall-e-3"]) {
    assert.ok(!catalog.models.some(model => model.id === retired));
    assert.throws(() => assertOpenAIImageModel(retired), (error: unknown) => error instanceof HttpError && error.code === "IMAGE_MODEL_INCOMPATIBLE");
  }
  catalog.models[0].id = "mutated-model";
  assert.ok(!(await loadOpenAIImageModels()).models.some(model => model.id === "mutated-model"));
  assert.throws(() => assertOpenAIImageModel("mutated-model"), (error: unknown) => error instanceof HttpError && error.code === "IMAGE_MODEL_INCOMPATIBLE");
});
