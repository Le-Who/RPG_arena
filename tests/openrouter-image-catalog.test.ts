import test from "node:test";
import assert from "node:assert/strict";
import { assertOpenRouterImageEndpoint, loadOpenRouterImageModels, parseOpenRouterImageEndpoints, parseOpenRouterImageModels } from "../src/lib/openrouter-image-catalog";
import { assertPollinationsGenerationModel, parseImageModels } from "../src/lib/visual-models";

const parameters = { input_references: { type: "range", min: 0, max: 14 } };
test("public list omits confirmed reference-required and SVG-only models before endpoint discovery", () => {
  const architecture = { input_modalities: ["text", "image"], output_modalities: ["image"] };
  const models = parseOpenRouterImageModels({ data: [
    { id: "fixture/required", architecture, supported_parameters: { input_references: { type: "range", min: 1, max: 2 } } },
    { id: "fixture/vector", architecture, supported_parameters: { ...parameters, output_format: { type: "enum", values: ["svg"] } } },
    { id: "fixture/optional", architecture, supported_parameters: parameters },
    { id: "fixture/unknown", architecture },
  ] });
  assert.deepEqual(models.map(model => model.id), ["fixture/optional", "fixture/unknown"]);
  assert.ok(models.every(model => !model.generationSupported), "endpoint discovery still confirms the chosen route");
});
test("endpoint eligibility requires optional references, pinnable provider and raster output", () => {
  const endpoints = parseOpenRouterImageEndpoints("vendor/model", { id: "vendor/model", endpoints: [
    { provider_tag: "optional", supported_parameters: parameters, pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.04 }] },
    { provider_tag: "required", supported_parameters: { input_references: { type: "range", min: 1, max: 1 } } },
    { provider_tag: "svg", supported_parameters: { ...parameters, output_format: { type: "enum", values: ["svg"] } } },
    { provider_tag: null, supported_parameters: parameters },
    { provider_tag: "unknown", supported_parameters: {} },
    { provider_tag: "mixed", supported_parameters: { ...parameters, output_format: { type: "enum", values: ["svg", "png"] } } },
  ] });
  assert.deepEqual(endpoints.map(value => value.endpoint), ["optional", "mixed"]);
  assert.equal(endpoints[0].price?.amount, 0.04);
});

test("known required-image aliases cannot bypass catalog or server validation; optional refs remain", () => {
  const base = { category: "image", community: false, input_modalities: ["text", "image"], output_modalities: ["image"], supported_endpoints: ["/image/{prompt}"] };
  const excluded = ["prunaai/p-image-edit", "pruna-edit", "pruna-image-edit", "p-image-edit", "recraft/recraft-v4.1-vector", "recraft-svg"];
  for (const id of excluded) assert.throws(() => assertPollinationsGenerationModel(id));
  assert.doesNotThrow(() => assertPollinationsGenerationModel("flux-kontext"));
  assert.deepEqual(parseImageModels([...excluded.map(name => ({ ...base, name })), { ...base, name: "black-forest-labs/flux-kontext", aliases: ["flux-kontext"] }]).map(row => row.id), ["black-forest-labs/flux-kontext"]);
});

test("catalog discovers at most three defaults plus selected model; server rejects manual endpoint bypass", async () => {
  const originalFetch = global.fetch; const calls: string[] = [];
  try {
    global.fetch = async url => {
      calls.push(String(url));
      if (String(url).endsWith("/images/models")) return Response.json({ data: Array.from({ length: 30 }, (_, i) => ({ id: `fixture/model-${i}`, name: `Model ${i}`, architecture: { input_modalities: ["text"], output_modalities: ["image"] }, supported_parameters: parameters })) });
      const id = String(url).split("/images/models/")[1].replace("/endpoints", "");
      return Response.json({ id, endpoints: [{ provider_tag: "fixture", supported_parameters: parameters, pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.04 }] }] });
    };
    const catalog = await loadOpenRouterImageModels({ model: "fixture/model-20", refresh: true });
    assert.equal(calls.length, 5); assert.equal(catalog.models.length, 30);
    assert.equal(catalog.models.filter(model => model.generationSupported).length, 4);
    assert.equal(catalog.models.find(model => model.id === "fixture/model-20")?.endpoint, "fixture");
    await assertOpenRouterImageEndpoint("fixture/model-20", "fixture");
    await assert.rejects(assertOpenRouterImageEndpoint("fixture/model-20", "invented"));
    assert.equal(calls.length, 5);
    assert.ok(calls.every(url => !url.includes("invented")));
  } finally { global.fetch = originalFetch; }
});

test("duplicate routing tags cannot select a required-reference or SVG endpoint indirectly", () => {
  assert.deepEqual(parseOpenRouterImageEndpoints("vendor/ambiguous", { id: "vendor/ambiguous", endpoints: [
    { provider_tag: "shared", supported_parameters: parameters, pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.01 }] },
    { provider_tag: "shared", supported_parameters: { input_references: { type: "range", min: 1, max: 1 } } },
  ] }), []);
});

test("metadata validation rejects arbitrary model paths without a network request", async () => {
  const originalFetch = global.fetch; let calls = 0;
  try {
    global.fetch = async () => { calls++; throw new Error("Must not fetch"); };
    for (const id of ["../evil", "https://evil.test/model", "vendor/model/../../evil", "vendor/model?key=secret"]) await assert.rejects(assertOpenRouterImageEndpoint(id, "fixture"));
    assert.equal(calls, 0);
  } finally { global.fetch = originalFetch; }
});

test("metadata hard deadline rejects an upstream fetch that ignores cancellation", async t => {
  const originalFetch = global.fetch; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    global.fetch = async () => { entered(); return new Promise<Response>(() => {}); };
    const request = assertOpenRouterImageEndpoint("deadline/model", "fixture");
    const rejected = assert.rejects(request, /OpenRouter/);
    await started; t.mock.timers.tick(8000); await rejected;
  } finally { global.fetch = originalFetch; t.mock.timers.reset(); }
});

test("selected endpoint price is pinned to the saved route; missing routes never quote another provider", async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async url => String(url).endsWith("/images/models")
      ? Response.json({ data: [{ id: "fixture/multiple", architecture: { input_modalities: ["text"], output_modalities: ["image"] } }] })
      : Response.json({ id: "fixture/multiple", endpoints: [{ provider_tag: "first", supported_parameters: parameters, pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.04 }] }, { provider_tag: "saved", supported_parameters: parameters, pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.08 }] }] });
    const catalog = await loadOpenRouterImageModels({ model: "fixture/multiple", endpoint: "saved", refresh: true });
    assert.equal(catalog.models[0].endpoint, "saved"); assert.equal(catalog.models[0].price?.amount, 0.08);
    const missing = await loadOpenRouterImageModels({ model: "fixture/multiple", endpoint: "removed" });
    assert.equal(missing.models[0].endpoint, undefined); assert.equal(missing.models[0].price, undefined); assert.equal(missing.models[0].generationSupported, false);
  } finally { global.fetch = originalFetch; }
});
