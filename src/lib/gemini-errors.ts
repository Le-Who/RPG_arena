// Google GenerateContent error contract: https://ai.google.dev/gemini-api/docs/generate-content/api-errors
// Never include message, metadata, project IDs, URLs or arbitrary reason/status values in diagnostics.
const reasons = new Set([
  "API_KEY_INVALID", "API_KEY_EXPIRED", "API_KEY_SERVICE_BLOCKED", "API_KEY_HTTP_REFERRER_BLOCKED",
  "API_KEY_IP_ADDRESS_BLOCKED", "API_KEY_ANDROID_APP_BLOCKED", "API_KEY_IOS_APP_BLOCKED",
  "SERVICE_DISABLED", "BILLING_DISABLED", "RATE_LIMIT_EXCEEDED",
]);
const statuses = new Set([
  "INVALID_ARGUMENT", "UNAUTHENTICATED", "PERMISSION_DENIED", "FAILED_PRECONDITION", "NOT_FOUND",
  "RESOURCE_EXHAUSTED", "DEADLINE_EXCEEDED", "UNAVAILABLE", "INTERNAL", "CANCELLED", "ABORTED",
  "OUT_OF_RANGE", "UNIMPLEMENTED", "UNKNOWN",
]);
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
function reasonFromBody(value: unknown): string {
  const error = record(record(value)?.error);
  if (!error) return "UNKNOWN";
  if (Array.isArray(error.details)) for (const entry of error.details) {
    const info = record(entry);
    if (info?.["@type"] === "type.googleapis.com/google.rpc.ErrorInfo" && typeof info.reason === "string" && reasons.has(info.reason)) return info.reason;
  }
  return typeof error.status === "string" && statuses.has(error.status) ? error.status : "UNKNOWN";
}

/** Read at most 16 KiB for at most 250 ms, bounded further by the provider/caller deadline. */
export async function readGeminiHttpError(response: Response, signal?: AbortSignal): Promise<string> {
  const prefix = `HTTP ${response.status}: `;
  if (!response.body) return `${prefix}UNKNOWN`;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = response.body.getReader(); } catch { return `${prefix}UNKNOWN`; }
  const timeout = new AbortController();
  const deadline = Date.now() + 250;
  const timer = setTimeout(() => timeout.abort(), 250);
  const bounded = signal ? AbortSignal.any([timeout.signal, signal]) : timeout.signal;
  let abort!: () => void;
  try {
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => { void reader.cancel().catch(() => {}); reject(new Error("DIAGNOSTIC_INTERRUPTED")); };
      bounded.addEventListener("abort", abort, { once: true });
    });
    let bytes = 0, text = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    while (!bounded.aborted && Date.now() < deadline) {
      const { done, value } = await Promise.race([reader.read(), interrupted]);
      if (bounded.aborted || Date.now() >= deadline) break;
      bytes += value?.byteLength ?? 0;
      if (bytes > 16 * 1024) break;
      text += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (done) return prefix + reasonFromBody(JSON.parse(text));
    }
  } catch { /* Body, parsing and cancellation errors must not leak provider content. */ }
  finally {
    clearTimeout(timer);
    bounded.removeEventListener("abort", abort);
    // A stalled underlying cancellation must not extend this or the provider deadline.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return `${prefix}UNKNOWN`;
}

/** Client-safe copy accepts only complete diagnostics produced at the Gemini boundary. */
export function geminiFailureMessage(errorMessage: string): string | null {
  if (["TIMEOUT", "AI_DEADLINE:TIMEOUT"].includes(errorMessage)) return "Gemini не ответил вовремя. Повторите попытку позже.";
  if (errorMessage === "ABORTED") return "Запрос к Gemini прерван. Повторите попытку.";
  const match = /^(?:(?:ALL_MODELS_FAILED|AI_DEADLINE):)?HTTP ([45]\d{2}): ([A-Z_]+)$/.exec(errorMessage);
  if (!match || match[0] !== errorMessage || (!reasons.has(match[2]) && !statuses.has(match[2]))) return null;
  const status = Number(match[1]), reason = match[2];
  if (reason === "API_KEY_INVALID") return "Google отклонил ключ Gemini. Создайте новый ключ в Google AI Studio и сохраните его в настройках.";
  if (reason === "API_KEY_EXPIRED") return "Срок действия ключа Gemini истёк. Создайте новый ключ в Google AI Studio и сохраните его в настройках.";
  if (reason === "SERVICE_DISABLED") return "Gemini API отключён для проекта Google. Проверьте, что API включён в проекте вашего ключа.";
  if (reason === "BILLING_DISABLED") return "Google отклонил запрос из-за настроек оплаты проекта Gemini. Проверьте их в Google AI Studio.";
  if (reason.startsWith("API_KEY_") || reason === "PERMISSION_DENIED" || status === 403) return "Google ограничил доступ к Gemini. Проверьте разрешения и ограничения ключа в Google AI Studio.";
  if (reason === "FAILED_PRECONDITION") return "Google не разрешил запрос при текущих условиях проекта. Проверьте доступность Gemini API и настройки оплаты в Google AI Studio.";
  if (reason === "UNAUTHENTICATED" || status === 401) return "Google не принял авторизацию Gemini. Проверьте ключ и сохраните действующий ключ в настройках.";
  if (status === 402) return "Для проекта Gemini исчерпан оплаченный баланс. Проверьте баланс и настройки оплаты в Google AI Studio.";
  if (reason === "RESOURCE_EXHAUSTED" || reason === "RATE_LIMIT_EXCEEDED" || status === 429) return "Google сообщил о превышении лимита Gemini. Проверьте квоты проекта в Google AI Studio и повторите после восстановления лимита.";
  if (reason === "DEADLINE_EXCEEDED" || status === 408 || status === 504) return "Gemini не ответил вовремя. Повторите попытку позже.";
  if (reason === "INVALID_ARGUMENT" || reason === "OUT_OF_RANGE") return "Google отклонил параметры запроса к Gemini. Обновите приложение; если ошибка повторится, сообщите разработчику.";
  if (status === 400) return "Google отклонил запрос к Gemini (HTTP 400). Причина не уточнена; сообщите об ошибке разработчику.";
  if (reason === "NOT_FOUND" || status === 404) return "Google не нашёл выбранную модель или ресурс Gemini. Проверьте модель в настройках.";
  if (reason === "CANCELLED" || reason === "ABORTED" || status === 499) return "Запрос к Gemini прерван. Повторите попытку.";
  if (status >= 500) return "Gemini временно недоступен. Повторите попытку позже.";
  return null;
}
