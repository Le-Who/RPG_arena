/** The stable model and its vector space are intentionally not interchangeable with preview/001. */
export const EMBEDDING_MODEL = "gemini-embedding-2";
export const DEFAULT_EMBEDDING_DIMS = 768;
export function formatDocument(title: string, content: string): string {
  return `title: ${title || "none"} | text: ${content}`.slice(0, 6000);
}
export function formatQuery(query: string): string {
  return `task: search result | query: ${query}`.slice(0, 4000);
}
export function isValidVector(value: unknown, dims: number): value is number[] {
  return Array.isArray(value) && value.length === dims && value.every((n) => typeof n === "number" && Number.isFinite(n)) && value.some((n) => n !== 0);
}
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new RangeError("Incompatible vector dimensions");
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) throw new TypeError("Non-finite vector value");
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  return na && nb ? Math.max(-1, Math.min(1, dot / Math.sqrt(na * nb))) : 0;
}
