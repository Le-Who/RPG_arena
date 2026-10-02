import { admitBeforeFetch, callGeminiWithRotation, type GeminiCallOptions } from "./gemini-transport";
import { QuotaAdmissionError } from "./quota-errors";

export type TextProvider = "gemini" | "openrouter" | "pollinations";
type TextConfig = { textProvider?: TextProvider; textModel?: string; textApiKey?: string };
const ENDPOINTS = {
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  pollinations: "https://gen.pollinations.ai/v1/chat/completions",
} as const;

/** Remove Gemini's presentation hint, preserving every validation keyword and open map. */
function compatibleSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compatibleSchema);
  if (!value || typeof value !== "object") return value;
  const maps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
  const children = new Set(["items", "prefixItems", "additionalProperties", "contains", "propertyNames", "not", "if", "then", "else", "allOf", "anyOf", "oneOf"]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "propertyOrdering").map(([key, item]) => [key,
    maps.has(key) && item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).map(([name, schema]) => [name, compatibleSchema(schema)]))
      : children.has(key) ? compatibleSchema(item) : item,
  ]));
}

type Usage = { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number }; prompt_tokens_details?: { cached_tokens?: number } };
type Completion = { error?: unknown; choices?: { index?: number; delta?: { content?: unknown }; message?: { content?: unknown; refusal?: unknown }; finish_reason?: string | null }[]; usage?: Usage };

/** Reads stay cancellable after headers, even for a synthetic or stalled stream. */
async function readCompletion(response: Response, signal: AbortSignal, onText?: (delta: string) => void) {
  if (!response.body) throw new Error("EMPTY_RESPONSE");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = "", finish = "", buffer = "", bytes = 0, usage: Usage | undefined;
  const streaming = response.headers.get("content-type")?.includes("text/event-stream");
  const consume = (data: Completion) => {
    if (data.error) throw new Error("PROVIDER_STREAM_ERROR");
    const choice = data.choices?.find(choice => choice.index === undefined || choice.index === 0);
    if (choice?.message?.refusal) throw new Error("PROVIDER_REFUSAL");
    const delta = streaming ? choice?.delta?.content : choice?.message?.content;
    if (delta !== undefined && delta !== null && typeof delta !== "string") throw new Error("INVALID_RESPONSE");
    if (typeof delta === "string") {
      text += delta;
      if (text.length > 200_000) throw new Error("RESPONSE_TOO_LARGE");
      if (delta) onText?.(delta);
    }
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (data.usage) usage = data.usage;
  };
  let lines: string[] = [], frameSize = 0;
  const line = (value: string) => {
    if (value.startsWith("data:")) {
      const payload = value.slice(5).trimStart();
      frameSize += payload.length;
      if (frameSize > 250_000) throw new Error("STREAM_FRAME_TOO_LARGE");
      lines.push(payload);
    } else if (!value && lines.length) {
      const payload = lines.join("\n"); lines = []; frameSize = 0;
      if (payload !== "[DONE]") consume(JSON.parse(payload));
    }
  };
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      bytes += value?.byteLength ?? 0;
      // Bound wire bytes as well as generated text; reasoning and ignored fields also consume memory.
      if (bytes > 2_000_000) throw new Error("RESPONSE_TOO_LARGE");
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (streaming) {
        let at: number;
        while ((at = buffer.indexOf("\n")) !== -1) { line(buffer.slice(0, at).replace(/\r$/, "")); buffer = buffer.slice(at + 1); }
        if (buffer.length > 250_000) throw new Error("STREAM_FRAME_TOO_LARGE");
      }
      if (done) {
        if (streaming) { if (buffer) line(buffer.replace(/\r$/, "")); line(""); }
        else consume(JSON.parse(buffer));
        break;
      }
    }
  } finally {
    signal.removeEventListener("abort", abort);
    // Do not let an unresponsive cancellation hold the deadline open.
    void reader.cancel().catch(() => {}); reader.releaseLock();
  }
  if (finish !== "stop") throw new Error(`INCOMPLETE_RESPONSE:${finish === "length" || finish === "content_filter" || finish === "tool_calls" ? finish : "EOF"}`);
  if (!text) throw new Error("EMPTY_RESPONSE");
  return { text, usage };
}

const safeCodes = new Set(["PROVIDER_STREAM_ERROR", "PROVIDER_REFUSAL", "INVALID_RESPONSE", "RESPONSE_TOO_LARGE", "STREAM_FRAME_TOO_LARGE", "EMPTY_RESPONSE"]);
function safeError(error: unknown, signal: AbortSignal) {
  if (signal.aborted) return "TIMEOUT";
  if (error instanceof Error && (safeCodes.has(error.message) || /^INCOMPLETE_RESPONSE:(length|content_filter|tool_calls|EOF)$/.test(error.message))) return error.message;
  return "PROVIDER_ERROR";
}

/** External providers use one selected model and one configured key; never Gemini fallback. */
export async function callTextWithConfig(cfg: TextConfig, opts: GeminiCallOptions): ReturnType<typeof callGeminiWithRotation> {
  const provider = cfg.textProvider ?? "gemini";
  if (provider === "gemini") return callGeminiWithRotation(opts);
  if (provider !== "openrouter" && provider !== "pollinations") throw new Error("INVALID_TEXT_PROVIDER");
  const key = cfg.textApiKey?.trim();
  if (!key) throw new Error("NO_KEYS");
  const model = opts.models[0];
  if (!model) throw new Error("NO_MODELS_AVAILABLE");
  const deadline = Date.now() + Math.min(opts.timeoutMs ?? 35_000, 45_000);
  let attempts = 0, lastError = "PROVIDER_ERROR", retryAfterMs = 250;
  for (let round = 0; round < 2; round++) {
    opts.signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining < 250) throw new Error(`AI_DEADLINE:${lastError}`);
    const signal = opts.signal ? AbortSignal.any([AbortSignal.timeout(remaining), opts.signal]) : AbortSignal.timeout(remaining);
    let allowed: boolean;
    try {
      allowed = await admitBeforeFetch(opts.beforeAttempt ? () => opts.beforeAttempt!(model) : undefined, signal);
    } catch (error) {
      if (error instanceof QuotaAdmissionError) throw new QuotaAdmissionError(error.code, attempts);
      if (opts.signal?.aborted) throw new QuotaAdmissionError("QUOTA_ADMISSION_CANCELLED", attempts);
      if (signal.aborted) throw new QuotaAdmissionError("QUOTA_ADMISSION_TIMEOUT", attempts);
      throw error;
    }
    if (!allowed) throw new QuotaAdmissionError("QUOTA_EXHAUSTED", attempts);
    if (opts.signal?.aborted) throw new QuotaAdmissionError("QUOTA_ADMISSION_CANCELLED", attempts);
    if (signal.aborted) throw new QuotaAdmissionError("QUOTA_ADMISSION_TIMEOUT", attempts);
    const started = Date.now();
    let retryable = true;
    opts.onAttemptStart?.();
    try {
      attempts++;
      const response = await fetch(ENDPOINTS[provider], {
        method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: "system", content: opts.system }, { role: "user", content: opts.user }],
          temperature: opts.temperature ?? 0.85, max_tokens: opts.maxTokens ?? 1600,
          stream: Boolean(opts.onText), ...(opts.onText ? { stream_options: { include_usage: true } } : {}),
          ...(provider === "openrouter" ? { provider: { allow_fallbacks: false, ...(opts.responseSchema ? { require_parameters: true } : {}) } } : {}),
          ...(opts.responseSchema ? { response_format: { type: "json_schema", json_schema: { name: "chronicle_response", strict: false, schema: compatibleSchema(opts.responseSchema) } } } : {}),
        }),
      });
      if (!response.ok) {
        retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
        const retry = response.headers.get("retry-after");
        if (retry) { const ms = /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now(); if (Number.isFinite(ms)) retryAfterMs = Math.max(250, Math.min(2000, ms)); }
        void response.body?.cancel().catch(() => {});
        lastError = `HTTP ${response.status}: провайдер текста недоступен`;
        throw new Error(lastError);
      }
      const { text, usage } = await readCompletion(response, signal, opts.onText);
      const latencyMs = Date.now() - started;
      const tokens = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
      const promptTokens = tokens(usage?.prompt_tokens, Math.ceil((opts.system.length + opts.user.length) / 3.5));
      const completionTokens = tokens(usage?.completion_tokens, Math.ceil(text.length / 3.5));
      await opts.onAttempt?.({ model, keyIndex: 0, ok: true, latencyMs, promptTokens, completionTokens });
      return { text, model, keyIndex: 0, latencyMs, promptTokens, completionTokens,
        thoughtTokens: tokens(usage?.completion_tokens_details?.reasoning_tokens, 0), cachedTokens: tokens(usage?.prompt_tokens_details?.cached_tokens, 0) };
    } catch (error) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      lastError = error instanceof Error && /^HTTP \d{3}: провайдер текста недоступен$/.test(error.message) ? error.message : safeError(error, signal);
      await opts.onAttempt?.({ model, keyIndex: 0, ok: false, latencyMs: Date.now() - started, error: lastError });
      if (!retryable || round === 1) break;
    }
    if (deadline - Date.now() <= retryAfterMs + 250) throw new Error(`AI_DEADLINE:${lastError}`);
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(opts.signal?.reason); };
      const timer = setTimeout(() => { opts.signal?.removeEventListener("abort", abort); resolve(); }, retryAfterMs);
      opts.signal?.addEventListener("abort", abort, { once: true });
    });
  }
  throw new Error(`ALL_MODELS_FAILED:${lastError}`);
}
