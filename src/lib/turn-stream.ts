import type { TurnError, TurnResponse, TurnStage } from "./turn-contract";
export type TurnEvent = { type: "stage"; stage: TurnStage } | { type: "narration"; text: string } | { type: "committed"; result: TurnResponse } | { type: "error"; error: TurnError };

/** Provisional display only. Never use partial JSON to apply game state. */
export function narrationPreview(json: string): string {
  const match = /^\s*\{\s*"narration"\s*:\s*"/.exec(json);
  if (!match) return "";
  let out = "";
  for (let i = match[0].length; i < json.length; i++) {
    const char = json[i];
    if (char === '"') break;
    if (char !== "\\") { out += char; continue; }
    const escaped = json[++i];
    if (!escaped) break;
    if (escaped === "u") {
      const hex = json.slice(i + 1, i + 5);
      if (!/^[\da-f]{4}$/i.test(hex)) break;
      out += String.fromCharCode(parseInt(hex, 16)); i += 4;
    } else {
      const chars: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
      if (!(escaped in chars)) break;
      out += chars[escaped];
    }
  }
  return out.replace(/[\uD800-\uDBFF]$/, "").slice(0, 12_000);
}

export class TurnStreamError extends Error {
  constructor(public error: TurnError) { super(error.message); }
}
export async function readTurnStream(response: Response, onEvent: (event: TurnEvent) => void): Promise<TurnResponse> {
  if (!response.body) throw new Error("STREAM_INTERRUPTED: ответ не получен; проверяем сохранение хода.");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 500_000) throw new Error("STREAM_TOO_LARGE");
      let at: number;
      while ((at = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line) as TurnEvent;
        onEvent(event);
        if (event.type === "error") throw new TurnStreamError(event.error);
        if (event.type === "committed" && event.result?.ok) return event.result;
      }
      if (done) throw new Error("STREAM_INTERRUPTED: связь прервалась; проверяем сохранение хода.");
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
