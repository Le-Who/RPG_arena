import test from "node:test";
import assert from "node:assert/strict";
import { comparableModelPrice, formatModelPrice, formatPriceRate, getGeminiModelPrice, getKnownModelPrice, normalizeOpenRouterImagePrice, normalizeOpenRouterTextPrice, normalizePollinationsPrice, shortlistModels } from "../src/lib/model-pricing";

const checkedAt = "2026-10-19T00:00:00.000Z";
test("image prices retain per-image, megapixel conversion, token rates and execution fees", () => {
  const fixed = normalizePollinationsPrice({ flat_rate: true, pricing: { currency: "pollen", completionImageTokens: "0.0001" } }, "image", checkedAt);
  assert.equal(fixed.status, "fixed"); assert.equal(fixed.amount, 0.0001); assert.equal(fixed.unit, "image");
  assert.match(formatModelPrice(fixed), /0,0001 Pollen.*изображение/);
  const mp = normalizePollinationsPrice({ flat_rate: true, pricing: { currency: "pollen", completionImageTokens: "0.00000002" }, pricing_units: { completionImageTokens: { unit: "megapixel", quantity: 1000000 } } }, "image", checkedAt);
  assert.equal(mp.rates[0].amount, 0.02); assert.equal(mp.rates[0].unit, "megapixel"); assert.equal(comparableModelPrice(mp), null); assert.match(formatModelPrice(mp), /0,02 Pollen.*Мп/);
  const tokens = normalizePollinationsPrice({ flat_rate: false, pricing: { currency: "pollen", promptTextTokens: "0.0000005", completionImageTokens: "0.00003" } }, "image", checkedAt);
  assert.equal(tokens.status, "estimate"); assert.equal(tokens.complete, false); assert.equal(tokens.rates[1].unit, "token"); assert.match(formatModelPrice(tokens), /30 Pollen.*млн токенов изображения/); assert.equal(comparableModelPrice(tokens), null);
  const fees = normalizePollinationsPrice({ flat_rate: true, pricing: { currency: "pollen", completionImageTokens: "0.03" }, pricing_adjustments: [{ name: "execution", price: "0.04", currency: "pollen", unit: "generation", quantity: 1 }] }, "image", checkedAt);
  assert.equal(fees.amount, 0.07); assert.equal(fees.rates.length, 2); assert.match(formatModelPrice(fees), /0,07/);
});

test("variants, conditional fees, unknown and true zero are never misleading cheapness rankings", () => {
  const unknown = normalizeOpenRouterImagePrice([], "https://fixture.test", checkedAt);
  assert.equal(unknown.status, "unknown"); assert.match(formatModelPrice(unknown), /Нет данных/); assert.equal(comparableModelPrice(unknown), null);
  const zero = normalizeOpenRouterImagePrice([{ billable: "output_image", unit: "image", cost_usd: 0 }], "https://fixture.test", checkedAt);
  assert.equal(zero.amount, 0); assert.equal(zero.status, "fixed"); assert.equal(comparableModelPrice(zero)?.amount, 0);
  const variants = normalizeOpenRouterImagePrice([{ billable: "output_image", unit: "image", cost_usd: 0.04, variant: "2k" }, { billable: "output_image", unit: "image", cost_usd: 0.08, variant: "4k" }], "https://fixture.test", checkedAt);
  assert.equal(variants.status, "estimate"); assert.equal(variants.variants?.length, 2); assert.equal(comparableModelPrice(variants), null); assert.match(formatModelPrice(variants), /параметров/);
  const conditional = normalizePollinationsPrice({ flat_rate: true, pricing: { currency: "pollen", completionImageTokens: "0.03" }, pricing_adjustments: [{ name: "option", price: "0.02", currency: "pollen", unit: "generation", quantity: 1, option: { value: "high", default: false } }] }, "image", checkedAt);
  assert.equal(conditional.complete, false); assert.equal(comparableModelPrice(conditional), null);
});

test("text shows the documented example, preserves cache rates and never equates a request to a turn", () => {
  const price = normalizeOpenRouterTextPrice({ prompt: "0.000001", completion: "0.000002", input_cache_read: "0.0000001", request: "0.001" }, checkedAt);
  assert.equal(price.amount, 0.011); assert.equal(price.unit, "request"); assert.equal(price.status, "estimate"); assert.equal(price.rates.length, 4);
  assert.ok(price.conditions.some(value => value.includes("8000") && value.includes("1000")));
  assert.ok(price.conditions.some(value => value.includes("ход")));
  assert.equal(normalizeOpenRouterTextPrice({ prompt: null, completion: 0 }, checkedAt).status, "unknown");
  assert.equal(normalizeOpenRouterTextPrice({ prompt: "-1", completion: "0" }, checkedAt).status, "unknown");
  const pollen = normalizePollinationsPrice({ pricing: { currency: "pollen", promptTextTokens: 0.000001, completionTextTokens: 0.000002, promptCachedTokens: 0.0000001, promptCacheWriteTokens: 0.00000125 } }, "text", checkedAt);
  assert.equal(pollen.rates.find(rate => rate.component === "cache_write")?.amount, 0.00000125);
});

test("dated direct Gemini paid mapping is independent of a user's possible free tier", () => {
  const price = getGeminiModelPrice("gemini-3.5-flash-lite");
  assert.equal(price.checkedAt, checkedAt); assert.equal(price.amount, 0.0049); assert.equal(price.currency, "USD");
  assert.equal(price.rates.find(rate => rate.component === "input_text")?.amount, 0.3 / 1_000_000);
  assert.ok(price.conditions.some(value => value.includes("бесплат")));
  assert.equal(getGeminiModelPrice("future/unknown").status, "unknown");
  assert.equal(getGeminiModelPrice("constructor").status, "unknown");
  assert.equal(comparableModelPrice({ ...price, stale: true }), null);
});

test("three-item shortlist pins selection and does not duplicate it", () => {
  const models = ["a", "b", "c", "d"].map(id => ({ id }));
  assert.deepEqual(shortlistModels(models, "d").map(m => m.id), ["d", "a", "b"]);
  assert.deepEqual(shortlistModels(models, "a").map(m => m.id), ["a", "b", "c"]);
  assert.deepEqual(shortlistModels(models, "b").map(m => m.id), ["a", "b", "c"], "radio selection keeps the current list order");
  assert.deepEqual(shortlistModels(models, "c").map(m => m.id), ["a", "b", "c"]);
  assert.deepEqual(shortlistModels(models, "missing").map(m => m.id), ["a", "b", "c"]);
});

test("Gemini introductory prices switch at the announced boundary and old tables are marked stale", () => {
  const intro = getGeminiModelPrice("gemini-3.8-flash", Date.parse("2026-12-31T23:59:59.000Z"));
  const after = getGeminiModelPrice("gemini-3.8-flash", Date.parse("2027-01-01T00:00:00.000Z"));
  assert.equal(intro.amount, 0.00975); assert.equal(after.amount, 0.0195); assert.equal(after.stale, true);
  assert.ok(after.conditions.some(condition => condition.includes("закончилась")));
});

test("unrecognized provider-unit fees and missing flat-rate confirmation cannot masquerade as a full image total", () => {
  const fee = normalizePollinationsPrice({ flat_rate: true, pricing: { currency: "pollen", completionImageTokens: "0.03" }, pricing_adjustments: [{ name: "provider-usage", price: "1", currency: "pollen", unit: "USD", quantity: 1 }] }, "image", checkedAt);
  assert.equal(fee.complete, false); assert.equal(comparableModelPrice(fee), null); assert.equal(fee.rates[1].unit, "provider_unit");
  assert.match(fee.rates[1].condition ?? "", /USD/);
  const missing = normalizePollinationsPrice({ pricing: { currency: "pollen", completionImageTokens: "0.03" } }, "image", checkedAt);
  assert.equal(missing.complete, false); assert.equal(missing.rates[0].unit, "token");
  const text = normalizeOpenRouterTextPrice({ prompt: "0.000001", completion: "0.000002", web_search: "100" }, checkedAt);
  assert.equal(text.amount, 0.01);
  assert.equal(normalizeOpenRouterTextPrice({ prompt: " ", completion: "0" }, checkedAt).status, "unknown");
});

test("dated fallback prices need no fetch, preserve aliases and never claim an unpinned OpenRouter route", () => {
  const price = getKnownModelPrice("pollinations", "image", "z-image");
  assert.equal(price.amount, 0.004); assert.equal(price.unit, "image"); assert.match(price.source, /pollinations/); assert.match(price.checkedAt, /^2026-10-19/);
  assert.equal(getKnownModelPrice("pollinations", "image", "dreamshaper").amount, 0.0001);
  assert.equal(getKnownModelPrice("pollinations", "image", "qwen/qwen-image-2.1").rates[0].amount, 0.02);
  assert.equal(getKnownModelPrice("openrouter", "image", "bytedance-seed/seedream-4.5", "seed").amount, 0.04);
  assert.equal(getKnownModelPrice("openrouter", "image", "bytedance-seed/seedream-4.5").status, "unknown");
  assert.equal(getKnownModelPrice("pollinations", "image", "missing").status, "unknown");
  assert.match(formatPriceRate({ component: "input_text", amount: 0.0000003, unit: "token" }, "USD"), /Входной текст.*0,3 USD.*млн токенов/);
  assert.match(formatPriceRate({ component: "fee:execution", amount: 0.04, unit: "request" }, "Pollen"), /Сбор провайдера.*0,04 Pollen.*запрос/);
});
