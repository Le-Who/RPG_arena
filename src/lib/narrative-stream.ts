type Draft = { header: Record<string, unknown> | null; text: string };
const empty = (): Draft => ({ header: null, text: "" });
const required = ["continuity", "outcome", "effects", "stateChanges", "choices"];

/** JSON.parse alone silently accepts duplicate keys, which could replace streamed metadata. */
export function parseUniqueJsonObject(input: string): Record<string, unknown> | null {
  if (input.length > 100000) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(input); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "{" || c === "[") {
      stack.push(c === "{" ? new Set() : null);
      if (stack.length > 64) return null;
    } else if (c === "}" || c === "]") stack.pop();
    else if (c === '"') {
      const end = stringEnd(input, i);
      if (end < 0) return null;
      let next = end;
      while (/\s/.test(input[next] ?? "") && next < input.length) next++;
      if (input[next] === ":") {
        const key = JSON.parse(input.slice(i, end)) as string;
        const keys = stack.at(-1);
        if (!keys || keys.has(key) || ["__proto__", "constructor", "prototype"].includes(key)) return null;
        keys.add(key);
      }
      i = end - 1;
    }
  }
  return parsed as Record<string, unknown>;
}

export function parseCompleteNarrativeDraft(input: string): Record<string, unknown> | null {
  const result = parseUniqueJsonObject(input);
  if (!result) return null;
  const rootKeys = Object.keys(result);
  if (rootKeys.length !== required.length + 1 || rootKeys.at(-1) !== "narration"
    || !required.every(k => rootKeys.includes(k))) return null;
  return typeof result.narration === "string" ? result : null;
}

function stringEnd(input: string, start: number) {
  for (let i = start + 1; i < input.length; i++) {
    if (input[i] === "\\") { i++; continue; }
    if (input[i] === '"') return i + 1;
  }
  return -1;
}
function decodedPrefix(input: string, start: number) {
  let text = "";
  for (let i = start + 1; i < input.length; i++) {
    const c = input[i];
    if (c === '"') break;
    if (c !== "\\") { if (c.charCodeAt(0) < 32) break; text += c; continue; }
    const next = input[++i];
    if (!next) break;
    if (next === "u") {
      const hex = input.slice(i + 1, i + 5);
      if (!/^[a-f\d]{4}$/i.test(hex)) break;
      text += String.fromCharCode(parseInt(hex, 16)); i += 4;
    } else {
      const escapes: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
      if (!(next in escapes)) break;
      text += escapes[next];
    }
  }
  return text.replace(/[\uD800-\uDBFF]$/, "");
}

/** Reads only complete top-level fields before narration; never applies partial operations. */
export function readNarrativeDraft(input: string): Draft {
  if (input.length > 100000) return empty();
  let at = 0;
  const whitespace = () => { while (/\s/.test(input[at] ?? "") && at < input.length) at++; };
  whitespace();
  if (input[at++] !== "{") return empty();
  const header: Record<string, unknown> = {};
  const seen = new Set<string>();
  while (at < input.length) {
    whitespace();
    if (input[at] !== '"') return empty();
    const keyEnd = stringEnd(input, at);
    if (keyEnd < 0) return empty();
    let key: string;
    try { key = JSON.parse(input.slice(at, keyEnd)); } catch { return empty(); }
    if (seen.has(key) || ["__proto__", "constructor", "prototype"].includes(key)) return empty();
    seen.add(key);
    at = keyEnd; whitespace();
    if (input[at++] !== ":") return empty();
    whitespace();
    if (key === "narration") {
      if (input[at] !== '"' || !required.every(k => seen.has(k))) return empty();
      return { header, text: decodedPrefix(input, at) };
    }
    const start = at;
    let depth = 0, done = false;
    for (; at < input.length; at++) {
      const c = input[at];
      if (c === '"') {
        const end = stringEnd(input, at);
        if (end < 0) return empty();
        at = end - 1;
      } else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") { if (depth === 0) return empty(); depth--; }
      else if (c === "," && depth === 0) { done = true; break; }
    }
    if (!done) return empty();
    try { header[key] = JSON.parse(input.slice(start, at)); } catch { return empty(); }
    at++;
  }
  return empty();
}

/** Admission must examine this entire prefix before exposing any new sentence. */
export function completeNarrativePrefix(text: string): string {
  let end = 0;
  for (const match of text.matchAll(/[.!?…](?=\s|$)/gu)) end = match.index + match[0].length;
  return text.slice(0, end);
}
