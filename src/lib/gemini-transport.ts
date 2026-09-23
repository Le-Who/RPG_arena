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

/** Fetch can resolve at headers; keep the deadline active until the entire body is consumed. */
async function readGeneration(response: Response, onText?: (delta: string) => void) {
  let text = "", finish = "";
  let usage: GeminiData["usageMetadata"];
  const consume = (data: GeminiData) => {
    if (data.error) throw new Error("PROVIDER_STREAM_ERROR");
    const candidate = data.candidates?.[0];
    const delta = candidate?.content?.parts?.filter(p => !p.thought).map(p => p.text ?? "").join("") ?? "";
    text += delta;
    if (text.length > 200_000) throw new Error("RESPONSE_TOO_LARGE");
    if (delta) onText?.(delta);
    if (candidate?.finishReason) finish = candidate.finishReason;
    if (data.usageMetadata) usage = data.usageMetadata;
  };
  const streaming = response.headers.get("content-type")?.includes("text/event-stream");
  if (!streaming) consume(await response.json());
  else {
    if (!response.body) throw new Error("EMPTY_STREAM");
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "", dataLines: string[] = [];
    const line = (value: string) => {
      if (value.startsWith("data:")) dataLines.push(value.slice(5).trimStart());
      else if (!value && dataLines.length) {
        const payload = dataLines.join("\n"); dataLines = [];
        if (payload !== "[DONE]") consume(JSON.parse(payload));
      }
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        if (buffer.length > 250_000) throw new Error("STREAM_FRAME_TOO_LARGE");
        let at: number;
        while ((at = buffer.indexOf("\n")) !== -1) { line(buffer.slice(0, at).replace(/\r$/, "")); buffer = buffer.slice(at + 1); }
        if (done) { if (buffer) line(buffer.replace(/\r$/, "")); line(""); break; }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  if ((streaming && finish !== "STOP") || (finish && finish !== "STOP")) throw new Error(`INCOMPLETE_RESPONSE:${finish || "EOF"}`);
  if (!text) throw new Error("EMPTY_RESPONSE");
  return { text, usage };
}

/** All keys on a model are tried before its transient failures are retried, then fallback. */
export async function callGeminiWithRotation(opts: GeminiCallOptions) {
  if (!opts.keys.length) throw new Error("NO_KEYS");
  if (!opts.models.length) throw new Error("NO_MODELS_AVAILABLE");
  const deadline = Date.now() + Math.min(opts.timeoutMs ?? 35_000, 45_000);
  let lastError = "unknown";
  let providerAttempts = 0;
  models: for (const model of opts.models) {
    let retryKeys: number[] = [], retryAfterMs = 250;
    for (let round = 0; round < 2; round++) {
      const keys = round ? retryKeys : opts.keys.map((_, i) => i);
      if (round && keys.length) {
        opts.signal?.throwIfAborted();
        if (deadline - Date.now() <= retryAfterMs + 250) throw new Error(`AI_DEADLINE:${lastError}`);
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(opts.signal?.reason ?? new Error("ABORTED")); };
          const timer = setTimeout(() => { opts.signal?.removeEventListener("abort", abort); resolve(); }, retryAfterMs);
          opts.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      let modelInvalid = false;
      for (const keyIndex of keys) {
        opts.signal?.throwIfAborted();
        const remaining = deadline - Date.now();
        if (remaining < 250) throw new Error(`AI_DEADLINE:${lastError}`);
        // Outside the provider catch: database failures and denials must never become provider retries.
        let allowed: boolean;
        try {
          allowed = await admitBeforeFetch(opts.beforeAttempt ? () => opts.beforeAttempt!(model) : undefined,
            opts.signal ? AbortSignal.any([AbortSignal.timeout(remaining), opts.signal]) : AbortSignal.timeout(remaining));
        } catch (error) {
          if (error instanceof QuotaAdmissionError) throw new QuotaAdmissionError(error.code, providerAttempts);
          throw error;
        }
        if (!allowed) {
          lastError = "QUOTA_EXHAUSTED";
          continue models;
        }
        opts.signal?.throwIfAborted();
        if (Date.now() >= deadline) throw new Error("AI_DEADLINE");
        const started = Date.now(), controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
        let retryable = false;
        opts.onAttemptStart?.();
        try {
          const endpoint = opts.onText ? "streamGenerateContent?alt=sse" : "generateContent";
          providerAttempts++;
          const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:${endpoint}`, {
            method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": opts.keys[keyIndex] },
            signal: opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal,
            body: JSON.stringify({ system_instruction: { parts: [{ text: opts.system }] }, contents: [{ role: "user", parts: [{ text: opts.user }] }],
              generationConfig: { temperature: opts.temperature ?? 0.85, maxOutputTokens: opts.maxTokens ?? 1600,
                ...(opts.responseSchema ? { responseMimeType: "application/json", responseSchema: opts.responseSchema } : {}) } }),
          });
          if (!response.ok) {
            modelInvalid = response.status === 404;
            retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
            const retry = response.headers.get("retry-after");
            if (retry) { const ms = /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now(); if (Number.isFinite(ms)) retryAfterMs = Math.max(retryAfterMs, Math.min(2000, ms)); }
            await response.body?.cancel().catch(() => {});
            throw new Error(`HTTP ${response.status}: Gemini временно недоступен`);
          }
          retryable = true;
          const { text, usage } = await readGeneration(response, opts.onText);
          const latencyMs = Date.now() - started;
          const promptTokens = Number(usage?.promptTokenCount) || Math.ceil((opts.system.length + opts.user.length) / 3.5);
          const completionTokens = Number(usage?.candidatesTokenCount) || Math.ceil(text.length / 3.5);
          await opts.onAttempt?.({ model, keyIndex, ok: true, latencyMs, promptTokens, completionTokens });
          return { text, model, keyIndex, latencyMs, promptTokens, completionTokens, thoughtTokens: usage?.thoughtsTokenCount ?? 0, cachedTokens: usage?.cachedContentTokenCount ?? 0 };
        } catch (error) {
          if (opts.signal?.aborted) throw opts.signal.reason;
          lastError = error instanceof Error ? (error.name === "AbortError" ? "TIMEOUT" : error.message) : "PROVIDER_ERROR";
          // Network errors also get a retry; permanent HTTP errors do not.
          if (!lastError.startsWith("HTTP ")) retryable = true;
          await opts.onAttempt?.({ model, keyIndex, ok: false, latencyMs: Date.now() - started, error: lastError });
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
