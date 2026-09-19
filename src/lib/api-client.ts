export class ApiError extends Error {
  constructor(message: string, public status: number, public code: string, public retryAfter?: number, public currentTurn?: number) { super(message); this.name = "ApiError"; }
}
export async function api<T = Record<string, unknown>>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.message || data.error || "Не удалось выполнить запрос. Попробуйте ещё раз.", res.status, data.code || data.error || "REQUEST_FAILED", data.retryAfter, data.currentTurn);
  return data as T;
}
export const jsonBody = (value: unknown) => ({ method: "POST", body: JSON.stringify(value) });
