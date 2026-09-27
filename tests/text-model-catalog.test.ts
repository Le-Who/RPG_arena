import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTextModelCatalog, parseTextModelCatalog } from "../src/lib/text-model-catalog";
import { GET } from "../src/app/api/settings/text-provider/models/route";

test("OpenRouter catalog includes only text input/output and confirms schema only explicitly", () => {
  const architecture = { input_modalities: ["text"], output_modalities: ["text"] };
  const models = parseTextModelCatalog("openrouter", { data: [
    { id: "a", name: "A", architecture, supported_parameters: ["structured_outputs"] },
    { id: "b", name: "B", architecture, supported_parameters: ["response_format"] },
    { id: "image", architecture: { input_modalities: ["text"], output_modalities: ["image"] } },
    { id: "speech", architecture: { input_modalities: ["audio"], output_modalities: ["text"] } },
    { id: "missing-modalities" }, { id: "a", name: "duplicate", architecture },
  ] });
  assert.deepEqual(models, [{ id: "a", name: "A", structuredOutput: true, streaming: true }, { id: "b", name: "B", structuredOutput: false, streaming: true }]);
});

test("Pollinations preserves canonical names and does not invent missing capabilities", () => {
  const modalities = { input_modalities: ["text", "image"], output_modalities: ["text"], supported_endpoints: ["/v1/chat/completions"] };
  assert.deepEqual(parseTextModelCatalog("pollinations", [
    { name: "canonical/a", title: "Title", aliases: ["alias"], ...modalities, supported_parameters: ["response_format", "stream"] },
    { name: "canonical/b", ...modalities, supported_parameters: ["json_schema"] },
    { name: "audio", input_modalities: ["text"], output_modalities: ["audio"] },
    { name: "responses-only", ...modalities, supported_endpoints: ["/v1/responses"] },
  ]), [{ id: "canonical/a", name: "Title", structuredOutput: false, streaming: true }, { id: "canonical/b", name: "canonical/b", structuredOutput: true, streaming: false }]);
});

test("invalid provider query does not fetch", async () => {
  const response = await GET(new Request("http://localhost/api/settings/text-provider/models?provider=evil"));
  assert.equal(response.status, 400);
});

test("catalog loader uses public fixed endpoint without credentials and caches successful results", async () => {
  const old = global.fetch; let calls = 0;
  try {
    global.fetch = async (url, init) => {
      calls++; assert.equal(String(url), "https://openrouter.ai/api/v1/models");
      assert.equal(new Headers(init?.headers).has("authorization"), false); assert.equal(init?.redirect, "error");
      return Response.json({ data: [{ id: "test/model", name: "Model", architecture: { input_modalities: ["text"], output_modalities: ["text"] }, supported_parameters: ["structured_outputs"] }] });
    };
    const models = await loadTextModelCatalog("openrouter");
    assert.equal(models[0].id, "test/model"); models[0].id = "mutated";
    const response = await GET(new Request("http://localhost/api/settings/text-provider/models?provider=openrouter"));
    assert.equal(response.status, 200); assert.equal((await response.json()).models[0].id, "test/model");
    assert.equal(calls, 1);
  } finally { global.fetch = old; }
});

test("provider failures and oversized catalog bodies return sanitized errors and are not cached", async () => {
  const old = global.fetch; let calls = 0;
  try {
    global.fetch = async () => { calls++; return Response.json({ error: "private-secret" }, { status: 503 }); };
    const response = await GET(new Request("http://localhost/api/settings/text-provider/models?provider=pollinations"));
    assert.equal(response.status, 502); assert.equal(JSON.stringify(await response.json()).includes("private-secret"), false);
    global.fetch = async () => { calls++; return new Response("x".repeat(3_000_001)); };
    await assert.rejects(() => loadTextModelCatalog("pollinations"), /CATALOG_UNAVAILABLE/);
    assert.equal(calls, 2);
  } finally { global.fetch = old; }
});

test("catalog deadline remains active through a stalled response body", async () => {
  const old = global.fetch; let cancelled = false;
  try {
    global.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    await assert.rejects(() => loadTextModelCatalog("pollinations"), /CATALOG_UNAVAILABLE/);
    assert.equal(cancelled, true);
  } finally { global.fetch = old; }
});
