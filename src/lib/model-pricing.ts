/** Public, pure pricing metadata. An example request is never a promise about a story turn. */
export type PriceUnit = "image" | "megapixel" | "token" | "request" | "provider_unit";
export type PriceRate = { component: string; amount: number; unit: PriceUnit; variant?: string; condition?: string };
export type PriceVariant = { id: string; label: string; description?: string; rates: PriceRate[] };
export type ModelPrice = {
  currency: "USD" | "Pollen";
  status: "fixed" | "estimate" | "unknown";
  amount?: number;
  unit?: PriceUnit;
  rates: PriceRate[];
  source: string;
  checkedAt: string;
  stale?: boolean;
  conditions: string[];
  variants?: PriceVariant[];
  /** True only when all costs for the stated basis are included. */
  complete: boolean;
  basis?: string;
  validUntil?: string;
};

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown): number | undefined => {
  if ((typeof value !== "number" && typeof value !== "string") || value === "") return undefined;
  if (typeof value === "string" && !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return undefined;
  const n = Number(value); return Number.isFinite(n) && n >= 0 && n <= 1e9 ? n : undefined;
};
const text = (value: unknown, max = 300) => typeof value === "string" ? value.slice(0, max) : "";
const rounded = (value: number) => Number(value.toPrecision(12));
const now = () => new Date().toISOString();
const unknownPrice = (currency: ModelPrice["currency"], source: string, checkedAt: string): ModelPrice => ({ currency, status: "unknown", rates: [], source, checkedAt, conditions: [], complete: false });
const TEXT_CONDITIONS = ["Пример одного запроса: 8000 входных + 1000 выходных токенов, без кэша и инструментов.", "Игровой ход может включать несколько запросов; его итоговая стоимость отличается."];

function textPrice(currency: ModelPrice["currency"], rates: PriceRate[], source: string, checkedAt: string): ModelPrice {
  const input = rates.find(rate => rate.component === "input_text" && !rate.variant);
  const output = rates.find(rate => rate.component === "output_text" && !rate.variant);
  const price = { ...unknownPrice(currency, source, checkedAt), rates, conditions: [...TEXT_CONDITIONS] };
  if (!input || !output) return price;
  const request = rates.filter(rate => rate.unit === "request" && !rate.variant && (rate.component === "request_fee" || rate.component.startsWith("fee:"))).reduce((sum, rate) => sum + rate.amount, 0);
  return { ...price, status: "estimate", amount: rounded(input.amount * 8000 + output.amount * 1000 + request), unit: "request", complete: true, basis: "text:8000:1000:uncached:no-tools" };
}

export function normalizeOpenRouterTextPrice(value: unknown, checkedAt = now()): ModelPrice {
  const source = "https://openrouter.ai/api/v1/models", pricing = record(value), rates: PriceRate[] = [];
  const mapping: Record<string, string> = { prompt: "input_text", completion: "output_text", input_cache_read: "cache_read", input_cache_write: "cache_write", request: "request_fee", web_search: "web_search", internal_reasoning: "reasoning" };
  for (const [key, component] of Object.entries(mapping)) {
    const amount = number(pricing[key]);
    if (amount !== undefined) rates.push({ component, amount, unit: key === "request" || key === "web_search" ? "request" : "token" });
  }
  const price = textPrice("USD", rates, source, checkedAt);
  price.conditions.push("Публичный тариф OpenRouter описывает верхний маршрут; иной маршрут может иметь другую цену.");
  return price;
}

const POLLINATIONS_COMPONENTS: Record<string, string> = { promptTextTokens: "input_text", promptImageTokens: "input_image", promptCachedTokens: "cache_read", promptCacheWriteTokens: "cache_write", completionTextTokens: "output_text", completionImageTokens: "output_image", completionReasoningTokens: "reasoning", promptAudioTokens: "input_audio", completionAudioTokens: "output_audio", promptVideoTokens: "input_video", completionVideoTokens: "output_video" };
function pollinationsRates(pricing: Record<string, unknown>, units: Record<string, unknown>, flat: boolean, variant?: string): PriceRate[] {
  const rates: PriceRate[] = [];
  for (const [key, component] of Object.entries(POLLINATIONS_COMPONENTS)) {
    const amount = number(pricing[key]); if (amount === undefined) continue;
    const descriptor = record(units[key]), quantity = number(descriptor.quantity) ?? 1;
    const knownUnit = descriptor.unit === undefined || ["megapixel", "image", "token"].includes(String(descriptor.unit));
    const unit: PriceUnit = !knownUnit ? "provider_unit" : descriptor.unit === "megapixel" ? "megapixel" : descriptor.unit === "image" ? "image" : flat && (component === "output_image" || component === "input_image") ? "image" : "token";
    rates.push({ component, amount: rounded(amount * quantity), unit, ...(variant ? { variant } : {}), ...(!knownUnit ? { condition: `Единица провайдера: ${text(descriptor.unit)}.` } : {}) });
  }
  return rates;
}

/** Keeps the provider's billing units, tiers and fees instead of treating every image rate as one image. */
export function normalizePollinationsPrice(value: unknown, kind: "text" | "image", checkedAt = now()): ModelPrice {
  const row = record(value), pricing = record(row.pricing), units = record(row.pricing_units);
  const source = `https://gen.pollinations.ai/${kind}/models`;
  if (pricing.currency !== "pollen") return unknownPrice("Pollen", source, checkedAt);
  const rates = pollinationsRates(pricing, units, row.flat_rate === true);
  const variants: PriceVariant[] = [];
  if (Array.isArray(row.pricing_variants)) for (const value of row.pricing_variants.slice(0, 100)) {
    const item = record(value), id = text(item.name); if (!id) continue;
    variants.push({ id, label: text(item.label) || id, description: text(item.description), rates: pollinationsRates(record(item.pricing), units, row.flat_rate === true, id) });
  }
  let conditionalFee = false;
  if (Array.isArray(row.pricing_adjustments)) for (const value of row.pricing_adjustments.slice(0, 100)) {
    const fee = record(value), amount = number(fee.price), quantity = number(fee.quantity) ?? 1;
    if (amount === undefined || fee.currency !== "pollen") { conditionalFee = true; continue; }
    const option = record(fee.option), conditional = Object.keys(option).length > 0;
    conditionalFee ||= conditional;
    const knownUnit = ["image", "megapixel", "generation", "request"].includes(String(fee.unit));
    conditionalFee ||= !knownUnit;
    const unit: PriceUnit = !knownUnit ? "provider_unit" : fee.unit === "image" ? "image" : fee.unit === "megapixel" ? "megapixel" : "request";
    rates.push({ component: `fee:${text(fee.name)}`, amount: rounded(amount * quantity), unit, ...(!knownUnit ? { condition: `Единица провайдера: ${text(fee.unit)}.` } : conditional ? { condition: text(option.label) || text(option.value) || "Зависит от параметров" } : {}) });
  }
  if (kind === "text") return { ...textPrice("Pollen", rates, source, checkedAt), ...(variants.length ? { variants } : {}) };
  const price: ModelPrice = { ...unknownPrice("Pollen", source, checkedAt), rates, ...(variants.length ? { variants } : {}) };
  if (!rates.length) return price;
  price.status = "estimate";
  price.conditions.push("Pollen — расчётная единица Pollinations; paid_only=false не означает бесплатную генерацию.");
  if (typeof row.pricing_default_label === "string") price.conditions.push(`Базовый тариф: ${text(row.pricing_default_label)}.`);
  const output = rates.find(rate => rate.component === "output_image");
  if (output) { price.amount = output.amount; price.unit = output.unit; }
  const extras = rates.filter(rate => rate.amount > 0 && rate.component !== "input_image" && rate !== output);
  if (output?.unit === "image" && !conditionalFee && extras.every(rate => rate.component.startsWith("fee:") && rate.unit === "request")) {
    price.amount = rounded(output.amount + extras.reduce((sum, rate) => sum + rate.amount, 0));
    price.status = "fixed"; price.complete = true; price.basis = "image:default:no-references";
  } else price.conditions.push("Указаны ставки; итог зависит от размера, токенов и дополнительных сборов.");
  return price;
}

export function normalizeOpenRouterImagePrice(value: unknown, source: string, checkedAt = now()): ModelPrice {
  const price = unknownPrice("USD", source, checkedAt);
  if (!Array.isArray(value) || value.length > 200) return price;
  let invalid = false;
  for (const item of value) {
    const row = record(item), amount = number(row.cost_usd);
    if (amount === undefined || !["image", "megapixel", "token", "request"].includes(String(row.unit)) || typeof row.billable !== "string") { invalid = true; continue; }
    price.rates.push({ component: text(row.billable), unit: row.unit as PriceUnit, amount, ...(row.variant ? { variant: text(row.variant) } : {}), ...(row.condition ? { condition: text(row.condition) } : {}) });
  }
  if (!price.rates.length) return price;
  price.status = "estimate";
  const variants = [...new Set(price.rates.flatMap(rate => rate.variant ? [rate.variant] : []))];
  if (variants.length) price.variants = variants.map(id => ({ id, label: id, rates: price.rates.filter(rate => rate.variant === id) }));
  const output = price.rates.find(rate => rate.component === "output_image" && !rate.variant);
  if (output) { price.amount = output.amount; price.unit = output.unit; }
  // This application generates without references; input images cannot contribute to this request.
  const billable = price.rates.filter(rate => rate.component !== "input_image" && rate.component !== "input_reference");
  if (!invalid && !variants.length && output?.unit === "image" && billable.every(rate => !rate.condition && (rate === output || rate.unit === "request"))) {
    price.amount = rounded(billable.reduce((sum, rate) => sum + rate.amount, 0));
    price.status = "fixed"; price.complete = true; price.basis = "image:default:no-references";
  } else price.conditions.push("Стоимость зависит от параметров, размера или числа токенов; указаны исходные ставки.");
  return price;
}

const formatNumber = (value: number) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 10 }).format(value);
const units: Record<PriceUnit, string> = { image: "изображение", megapixel: "Мп", token: "токен", request: "запрос", provider_unit: "ед. провайдера" };
function formatRateValue(rate: PriceRate, currency: ModelPrice["currency"]): string {
  const amount = rate.unit === "token" ? rounded(rate.amount * 1_000_000) : rate.amount;
  const unit = rate.unit === "token" ? rate.component.includes("image") ? "млн токенов изображения" : "млн токенов" : units[rate.unit];
  return `${formatNumber(amount)} ${currency} / ${unit}`;
}

export function formatPriceRate(rate: PriceRate, currency: ModelPrice["currency"]): string {
  const labels: Record<string, string> = { input_text: "Входной текст", output_text: "Выходной текст", input_image: "Входное изображение", output_image: "Выходное изображение", input_reference: "Исходное изображение", cache_read: "Чтение из кэша", cache_write: "Запись в кэш", input_audio: "Входное аудио", output_audio: "Выходное аудио", reasoning: "Рассуждение", web_search: "Поиск в интернете", request_fee: "Сбор за запрос" };
  const label = labels[rate.component] ?? (rate.component.startsWith("fee:") ? "Сбор провайдера" : "Ставка провайдера");
  return `${label}: ${formatRateValue(rate, currency)}${rate.variant ? ` · ${rate.variant}` : ""}${rate.condition ? ` · ${rate.condition}` : ""}`;
}

export function formatModelPrice(price?: ModelPrice): string {
  if (!price || price.status === "unknown") return "Нет данных о цене";
  const stale = price.stale ? " · цена устарела" : "";
  if (price.amount !== undefined && price.unit && price.complete) return `${price.status === "estimate" ? "≈ " : ""}${formatNumber(price.amount)} ${price.currency} / ${price.unit === "request" ? "пример запроса" : units[price.unit]}${price.variants?.length ? " · зависит от параметров" : ""}${stale}`;
  const output = price.rates.find(rate => rate.component === "output_image" && !rate.variant);
  if (output) {
    const fees = price.rates.filter(rate => rate.component.startsWith("fee:") && rate.amount > 0).map(rate => ` + ${formatRateValue(rate, price.currency)}`);
    return `${formatRateValue(output, price.currency)}${fees.join("")} · зависит от параметров${stale}`;
  }
  return `Зависит от параметров${stale}`;
}

/** A null result must sort after comparable prices, never as zero. Compare only equal currency/unit/basis. */
export function comparableModelPrice(price?: ModelPrice): { amount: number; currency: ModelPrice["currency"]; unit: PriceUnit; basis: string } | null {
  if (!price?.complete || price.status === "unknown" || price.stale || price.variants?.length || price.amount === undefined || !price.unit || !price.basis || !["image", "request"].includes(price.unit)) return null;
  return { amount: price.amount, currency: price.currency, unit: price.unit, basis: price.basis };
}

export function shortlistModels<T extends { id: string }>(models: T[], selectedId: string, limit = 3): T[] {
  const size = Math.max(0, Math.min(5, Math.floor(limit))), selected = models.find(model => model.id === selectedId);
  return [...(selected ? [selected] : []), ...models.filter(model => model.id !== selectedId)].slice(0, size);
}

/** Official standard paid text rates checked 2026-10-19; no account/free-tier assumptions. */
export function getGeminiModelPrice(model: string, at = Date.now()): ModelPrice {
  const checkedAt = "2026-10-19T00:00:00.000Z", source = "https://ai.google.dev/gemini-api/docs/pricing";
  const mapping: Record<string, { input: number; output: number; cache: number; until?: string; after?: [number, number, number]; condition?: string }> = {
    "gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cache: 0.03 },
    "gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cache: 0.025 },
    "gemini-3.8-flash": { input: 0.75, output: 3.75, cache: 0.075, until: "2027-01-01T00:00:00.000Z", after: [1.5, 7.5, 0.15] },
    "gemini-3.6-flash": { input: 0.75, output: 3.75, cache: 0.075, until: "2027-01-01T00:00:00.000Z", after: [1.5, 7.5, 0.15] },
    "gemini-4-argon": { input: 2, output: 10, cache: 0.1, until: "2026-12-01T00:00:00.000Z", after: [4, 20, 0.2] },
    "gemini-2.5-flash": { input: 0.3, output: 2.5, cache: 0.03 },
    "gemini-2.5-flash-lite": { input: 0.1, output: 0.4, cache: 0.01 },
    "gemini-2.5-pro": { input: 1.25, output: 10, cache: 0.125, condition: "Тариф для контекста до 200 000 токенов; более длинный контекст оплачивается иначе." },
  };
  const id = model.replace(/^models\//, ""), entry = Object.hasOwn(mapping, id) ? mapping[id] : undefined;
  if (!entry) return { ...unknownPrice("USD", source, checkedAt), conditions: ["Официальный тариф этой модели ещё не внесён в датированную таблицу."] };
  const expiredIntro = entry.until && at >= Date.parse(entry.until);
  const [input, output, cache] = expiredIntro && entry.after ? entry.after : [entry.input, entry.output, entry.cache];
  const price = textPrice("USD", [{ component: "input_text", amount: input / 1e6, unit: "token" }, { component: "output_text", amount: output / 1e6, unit: "token" }, { component: "cache_read", amount: cache / 1e6, unit: "token" }], source, checkedAt);
  price.conditions.push("Стандартный платный тариф Google. Доступность бесплатной квоты зависит от проекта и не подтверждается наличием ключа.");
  if (entry.condition) price.conditions.push(entry.condition);
  if (entry.until) { price.validUntil = entry.until; price.conditions.push(expiredIntro ? "Вводная цена закончилась; применена объявленная следующая ставка." : `Вводная цена действует до ${entry.until.slice(0, 10)}; далее применяется объявленная Google ставка.`); }
  // A dated table should visibly age, even if the announced future rate is known.
  price.stale = at - Date.parse(checkedAt) > 30 * 24 * 3600_000;
  return price;
}

/** Small dated public fallback for the closed summary. Opening the catalog replaces it with live metadata. */
export function getKnownModelPrice(provider: "gemini" | "openrouter" | "pollinations", kind: "text" | "image", id: string, endpoint?: string | null, at = Date.now()): ModelPrice {
  if (provider === "gemini" && kind === "text") return getGeminiModelPrice(id, at);
  const pollenCheckedAt = "2026-10-19T15:59:24.032Z", routerCheckedAt = "2026-10-19T16:08:43.329Z";
  let price: ModelPrice | undefined;
  if (provider === "pollinations" && kind === "image") {
    const fixed: Record<string, number> = {
      "tongyi-mai/z-image-turbo": 0.004, "z-image": 0.004, "z-image-turbo": 0.004, zimage: 0.004,
      "lykon/dreamshaper-8-lcm": 0.0001, sana: 0.0001, dreamshaper: 0.0001,
      "qwen/qwen-image-2.1-turbo": 0.016,
    };
    if (Object.hasOwn(fixed, id)) price = normalizePollinationsPrice({ flat_rate: true, pricing: { currency: "pollen", completionImageTokens: fixed[id] } }, "image", pollenCheckedAt);
    if (id === "qwen/qwen-image-2.1") price = normalizePollinationsPrice({ flat_rate: true, pricing: { currency: "pollen", completionImageTokens: 0.00000002 }, pricing_units: { completionImageTokens: { unit: "megapixel", quantity: 1_000_000 } } }, "image", pollenCheckedAt);
    if (["google/gemini-3.1-flash-lite-image", "nanobanana2lite", "nanobanana-lite", "nanobanana-2-lite"].includes(id)) price = normalizePollinationsPrice({ flat_rate: false, pricing: { currency: "pollen", promptTextTokens: 0.00000025, promptImageTokens: 0.00000025, completionTextTokens: 0.0000015, completionImageTokens: 0.00003 } }, "image", pollenCheckedAt);
    if (["black-forest-labs/flux.2-pro", "flux-2-pro"].includes(id)) price = normalizePollinationsPrice({ flat_rate: true, pricing: { currency: "pollen", completionImageTokens: 0.01125 }, pricing_units: { completionImageTokens: { unit: "megapixel" } }, pricing_adjustments: [{ name: "initial_output_megapixel", price: 0.01125, currency: "pollen", quantity: 1, unit: "generation" }] }, "image", pollenCheckedAt);
  }
  if (provider === "pollinations" && kind === "text" && ["openai/gpt-5.4-nano", "gpt-5.4-nano", "openai"].includes(id)) price = normalizePollinationsPrice({ pricing: { currency: "pollen", promptTextTokens: 0.00000015, promptCachedTokens: 0.000000015, completionTextTokens: 0.0000009375 } }, "text", pollenCheckedAt);
  if (provider === "openrouter" && kind === "image") {
    const source = `https://openrouter.ai/api/v1/images/models/${id}/endpoints`;
    if (id === "bytedance-seed/seedream-4.5" && endpoint === "seed") price = normalizeOpenRouterImagePrice([{ billable: "output_image", unit: "image", cost_usd: 0.04 }, { billable: "input_image", unit: "image", cost_usd: 0 }], source, routerCheckedAt);
    if (["black-forest-labs/flux.2-pro", "black-forest-labs/flux.2-klein-4b"].includes(id) && endpoint === "black-forest-labs") price = normalizeOpenRouterImagePrice([{ billable: "output_image", unit: "megapixel", cost_usd: id.endsWith("4b") ? 0.014 : 0.03 }], source, routerCheckedAt);
  }
  if (!price) return unknownPrice(provider === "pollinations" ? "Pollen" : "USD", provider === "pollinations" ? `https://gen.pollinations.ai/${kind}/models` : "https://openrouter.ai/api/v1/models", "2026-10-19T00:00:00.000Z");
  price.conditions.push("Сохранённый публичный тариф. Откройте выбор модели для обновления; цена и разрешения аккаунта могут измениться.");
  price.stale = at - Date.parse(price.checkedAt) >= 15 * 60_000;
  return price;
}
