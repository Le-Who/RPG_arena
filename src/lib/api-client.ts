export async function api<T = Record<string, unknown>>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || "Не удалось выполнить запрос. Попробуйте ещё раз.");
  return data as T;
}
export const jsonBody = (value: unknown) => ({ method: "POST", body: JSON.stringify(value) });
export function shortDate(value: string | Date): string {
  return new Intl.DateTimeFormat("ru", { day: "numeric", month: "short" }).format(new Date(value));
}
