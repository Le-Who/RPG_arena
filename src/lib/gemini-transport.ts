import { QuotaAdmissionError } from "./quota-errors";
export type AttemptInfo = { model: string; keyIndex: number; ok: boolean; latencyMs: number; error?: string; promptTokens?: number; completionTokens?: number };
export type GeminiCallOptions = {
  keys: string[]; models: string[]; system: string; user: string; maxTokens?: number; temperature?: number;
  responseSchema?: Record<string, unknown>; timeoutMs?: number; signal?: AbortSignal;
  onAttempt?: (info: AttemptInfo) => Promise<void> | void;
  onText?: (delta: string) => void;
  onAttemptStart?: () => void;
  /** Application quota admission; false skips this model, errors fail closed. */
  beforeAttempt?: (model: string) => Promise<boolean>;
};
/** Admission shares the provider deadline. Late reservations remain conservatively charged. */
export async function admitBeforeFetch(admit: (() => Promise<boolean>) | undefined, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!admit) return true;
  let abort!: () => void;
  try {
    const allowed = await Promise.race([admit(), new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true });
    })]);
    signal.throwIfAborted();
    return allowed;
  } finally { signal.removeEventListener("abort", abort); }
}
type GeminiData = { error?: unknown; candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number } };

// Only errors created at this boundary may carry diagnostic codes. Arbitrary exception messages
// (including messages that look like HTTP errors) can contain provider keys or response bodies.
class ProviderFailure extends Error {}
class CallbackFailure extends Error { constructor() { super("CALLBACK_ERROR"); } }
async function withSignal<T>(operation: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }), new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}
async function callback(operation: (() => unknown) | undefined, signal: AbortSignal) {
  if (!operation) return;
  try { await withSignal(operation, signal); }
  catch (error) { if (signal.aborted) throw error; throw new CallbackFailure(); }
}
const finishReasons = new Set(["MAX_TOKENS", "SAFETY", "RECITATION", "LANGUAGE", "OTHER", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "MALFORMED_FUNCTION_CALL", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_OTHER", "NO_IMAGE", "IMAGE_RECITATION", "UNEXPECTED_TOOL_CALL", "TOO_MANY_TOOL_CALLS", "MISSING_THOUGHT_SIGNATURE", "MALFORMED_RESPONSE", "ESCALATION", "PUP_LIMITED_DISABLED"]);
const tokens = (value: unknown, fallback: number) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;

/** Fetch can resolve at headers; keep the deadline active until the entire body is consumed. */
async function readGeneration(response: Response, signal: AbortSignal, onText?: (delta: string) => void) {
  let text = "", finish = "";
  let usage: GeminiData["usageMetadata"];
  const consume = async (data: GeminiData) => {
    if (!data || typeof data !== "object" || Array.isArray(data) || (data.candidates !== undefined && !Array.isArray(data.candidates))) throw new ProviderFailure("INVALID_RESPONSE");
    if (data.error) throw new ProviderFailure("PROVIDER_STREAM_ERROR");
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts;
    if (parts !== undefined && (!Array.isArray(parts) || parts.some(part => !part || typeof part !== "object" || (part.text !== undefined && typeof part.text !== "string")))) throw new ProviderFailure("INVALID_RESPONSE");
    const delta = parts?.filter(p => !p.thought).map(p => p.text ?? "").join("") ?? "";
    text += delta;
    if (text.length > 200_000) throw new ProviderFailure("RESPONSE_TOO_LARGE");
    if (delta) await callback(onText ? () => onText(delta) : undefined, signal);
    if (candidate?.finishReason) finish = finishReasons.has(candidate.finishReason) || candidate.finishReason === "STOP" ? candidate.finishReason : "UNKNOWN";
    if (data.usageMetadata) usage = data.usageMetadata;
  };
  const parse = (payload: string): GeminiData => {
    try { return JSON.parse(payload); } catch { throw new ProviderFailure("INVALID_RESPONSE"); }
  };
  const streaming = response.headers.get("content-type")?.includes("text/event-stream");
  if (!response.body) throw new ProviderFailure(streaming ? "EMPTY_STREAM" : "EMPTY_RESPONSE");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", dataLines: string[] = [], frameSize = 0, bytes = 0;
  const line = async (value: string) => {
    if (value.startsWith("data:")) {
      const payload = value.slice(5).trimStart();
      frameSize += payload.length + (dataLines.length ? 1 : 0);
      if (frameSize > 250_000) throw new ProviderFailure("STREAM_FRAME_TOO_LARGE");
      dataLines.push(payload);
    } else if (!value && dataLines.length) {
      const payload = dataLines.join("\n"); dataLines = []; frameSize = 0;
      if (payload !== "[DONE]") await consume(parse(payload));
    }
  };
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await withSignal(() => reader.read(), signal);
      signal.throwIfAborted();
      bytes += value?.byteLength ?? 0;
      if (bytes > 2_000_000) throw new ProviderFailure("RESPONSE_TOO_LARGE");
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (streaming) {
        let at: number;
        while ((at = buffer.indexOf("\n")) !== -1) { await line(buffer.slice(0, at).replace(/\r$/, "")); buffer = buffer.slice(at + 1); }
        if (buffer.length + frameSize > 250_000) throw new ProviderFailure("STREAM_FRAME_TOO_LARGE");
      }
      if (done) {
        if (streaming) { if (buffer) await line(buffer.replace(/\r$/, "")); await line(""); }
        else await consume(parse(buffer));
        break;
      }
    }
  } finally { signal.removeEventListener("abort", cancel); cancel(); reader.releaseLock(); }
  // Preserve the existing nonstream compatibility allowance for an omitted finishReason.
  if ((streaming && finish !== "STOP") || (finish && finish !== "STOP")) throw new ProviderFailure(`INCOMPLETE_RESPONSE:${finish || "EOF"}`);
  if (!text) throw new ProviderFailure("EMPTY_RESPONSE");
  return { text, usage };
}

/** All keys on a model are tried before its transient failures are retried, then fallback. */
export async function callGeminiWithRotation(opts: GeminiCallOptions) {
  if (!opts.keys.length) throw new Error("NO_KEYS");
  if (!opts.models.length) throw new Error("NO_MODELS_AVAILABLE");
  const deadline = Date.now() + Math.min(opts.timeoutMs ?? 35_000, 45_000);
  let lastError = "PROVIDER_ERROR";
  let providerAttempts = 0;
  models: for (const model of opts.models) {
    let retryKeys: number[] = [], retryAfterMs = 250;
    for (let round = 0; round < 2; round++) {
      const keys = round ? retryKeys : opts.keys.map((_, i) => i);
      if (round && keys.length) {
        if (opts.signal?.aborted) throw new Error("ABORTED");
        if (deadline - Date.now() <= retryAfterMs + 250) throw new Error(`AI_DEADLINE:${lastError}`);
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(new Error("ABORTED")); };
          const timer = setTimeout(() => { opts.signal?.removeEventListener("abort", abort); resolve(); }, retryAfterMs);
          opts.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      let modelInvalid = false;
      for (const keyIndex of keys) {
        if (opts.signal?.aborted) throw new Error("ABORTED");
        const remaining = deadline - Date.now();
        if (remaining < 250) throw new Error(`AI_DEADLINE:${lastError}`);
        // Outside the provider catch: database failures and denials must never become provider retries.
        let allowed: boolean;
        try {
          allowed = await admitBeforeFetch(opts.beforeAttempt ? () => opts.beforeAttempt!(model) : undefined,
            opts.signal ? AbortSignal.any([AbortSignal.timeout(remaining), opts.signal]) : AbortSignal.timeout(remaining));
        } catch (error) {
          if (error instanceof QuotaAdmissionError) throw new QuotaAdmissionError(error.code, providerAttempts);
          if (opts.signal?.aborted) throw new QuotaAdmissionError("QUOTA_ADMISSION_CANCELLED", providerAttempts);
          if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))
            throw new QuotaAdmissionError("QUOTA_ADMISSION_TIMEOUT", providerAttempts);
          throw error;
        }
        if (!allowed) {
          lastError = "QUOTA_EXHAUSTED";
          continue models;
        }
        if (opts.signal?.aborted) throw new QuotaAdmissionError("QUOTA_ADMISSION_CANCELLED", providerAttempts);
        if (Date.now() >= deadline) throw new QuotaAdmissionError("QUOTA_ADMISSION_TIMEOUT", providerAttempts);
        const started = Date.now(), controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
        const signal = opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal;
        let retryable = false, fetched = false, reported = false;
        // Terminal deadlines still account for an actual attempt. Dispatch once, without letting
        // a late or rejected logger extend the provider deadline or create an unhandled rejection.
        const reportTerminal = (error: string) => {
          if (!fetched || reported) return;
          reported = true;
          try { void Promise.resolve(opts.onAttempt?.({ model, keyIndex, ok: false, latencyMs: Date.now() - started, error })).catch(() => {}); }
          catch { /* Telemetry cannot expose its exception or delay terminal cancellation. */ }
        };
        try {
          await callback(opts.onAttemptStart, signal);
          const endpoint = opts.onText ? "streamGenerateContent?alt=sse" : "generateContent";
          const response = await withSignal(() => {
            providerAttempts++; fetched = true;
            return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:${endpoint}`, {
              method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": opts.keys[keyIndex] },
              signal,
              body: JSON.stringify({ system_instruction: { parts: [{ text: opts.system }] }, contents: [{ role: "user", parts: [{ text: opts.user }] }],
                generationConfig: { temperature: opts.temperature ?? 0.85, maxOutputTokens: opts.maxTokens ?? 1600,
                  ...(opts.responseSchema ? { responseMimeType: "application/json", responseSchema: opts.responseSchema } : {}) } }),
            }).then(response => {
              if (signal.aborted) void response.body?.cancel().catch(() => {});
              return response;
            });
          }, signal);
          if (!response.ok) {
            modelInvalid = response.status === 404;
            retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
            const retry = response.headers.get("retry-after");
            if (retry) { const ms = /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now(); if (Number.isFinite(ms)) retryAfterMs = Math.max(retryAfterMs, Math.min(2000, ms)); }
            void response.body?.cancel().catch(() => {});
            throw new ProviderFailure(`HTTP ${response.status}: Gemini временно недоступен`);
          }
          retryable = true;
          const { text, usage } = await readGeneration(response, signal, opts.onText);
          const latencyMs = Date.now() - started;
          const promptTokens = tokens(usage?.promptTokenCount, Math.ceil((opts.system.length + opts.user.length) / 3.5));
          const completionTokens = tokens(usage?.candidatesTokenCount, Math.ceil(text.length / 3.5));
          reported = true;
          await callback(opts.onAttempt ? () => opts.onAttempt!({ model, keyIndex, ok: true, latencyMs, promptTokens, completionTokens }) : undefined, signal);
          return { text, model, keyIndex, latencyMs, promptTokens, completionTokens, thoughtTokens: tokens(usage?.thoughtsTokenCount, 0), cachedTokens: tokens(usage?.cachedContentTokenCount, 0) };
        } catch (error) {
          if (opts.signal?.aborted) { reportTerminal("ABORTED"); throw new Error("ABORTED"); }
          if (signal.aborted) { reportTerminal("TIMEOUT"); throw new Error("AI_DEADLINE:TIMEOUT"); }
          if (error instanceof CallbackFailure) { reportTerminal("CALLBACK_ERROR"); throw new Error("CALLBACK_ERROR"); }
          lastError = error instanceof ProviderFailure ? error.message : "PROVIDER_ERROR";
          // Network errors also get a retry; permanent HTTP errors do not.
          if (!lastError.startsWith("HTTP ")) retryable = true;
          reported = true;
          try { await callback(opts.onAttempt ? () => opts.onAttempt!({ model, keyIndex, ok: false, latencyMs: Date.now() - started, error: lastError }) : undefined, signal); }
          catch { throw new Error(opts.signal?.aborted ? "ABORTED" : signal.aborted ? "AI_DEADLINE:TIMEOUT" : "CALLBACK_ERROR"); }
          if (!round && retryable) retryKeys.push(keyIndex);
        } finally { clearTimeout(timer); }
        if (modelInvalid) break;
      }
      if (modelInvalid) { retryKeys = []; break; }
    }
  }
  if (lastError === "QUOTA_EXHAUSTED") throw new QuotaAdmissionError("QUOTA_EXHAUSTED", providerAttempts);
  throw new Error(`ALL_MODELS_FAILED:${lastError}`);
}
