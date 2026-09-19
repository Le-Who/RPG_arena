export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) { super(message); this.name = "HttpError"; }
}
export async function readJsonObject(req: Request, maxBytes = 16384): Promise<Record<string, unknown>> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new HttpError(415, "CONTENT_TYPE", "Ожидается JSON-запрос.");
  const reader = req.body?.getReader();
  if (!reader) throw new HttpError(400, "INVALID_INPUT", "Тело запроса отсутствует.");
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new HttpError(413, "BODY_TOO_LARGE", "Запрос слишком большой."); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  let parsed: unknown;
  try { const bytes = new Uint8Array(total); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; } parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new HttpError(400, "INVALID_INPUT", "Некорректный JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "INVALID_INPUT", "Ожидается JSON-объект.");
  return parsed as Record<string, unknown>;
}
export function requiredText(value: unknown, label: string, max = 80): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new HttpError(400, "INVALID_INPUT", `${label}: укажите от 1 до ${max} символов.`);
  return value.trim();
}
export function requireUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new HttpError(400, "INVALID_INPUT", "Некорректный идентификатор.");
  return value;
}
export function expectedTurn(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new HttpError(400, "INVALID_INPUT", "Некорректная версия истории.");
  return value;
}
export function requestKey(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !/^[a-zA-Z0-9._:-]{1,80}$/.test(value)) throw new HttpError(400, "INVALID_INPUT", "Некорректный requestId.");
  return value;
}
export function httpError(error: unknown): Response {
  if (error instanceof HttpError) return Response.json({ ok: false, code: error.code, message: error.message, ...error.extra }, { status: error.status, headers: typeof error.extra.retryAfter === "number" ? { "Retry-After": String(error.extra.retryAfter) } : undefined });
  console.error("[request failed]", error instanceof Error ? error.name : "UnknownError");
  return Response.json({ ok: false, code: "INTERNAL", message: "Не удалось завершить запрос. Сохранённая история не потеряна." }, { status: 500 });
}
