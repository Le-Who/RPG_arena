/** Keep the deadline signal strongly reachable until the complete response is read. */
export async function readResponseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error("EMPTY_RESPONSE");
  const maxBytes = 2_000_000;
  if (Number(response.headers.get("content-length")) > maxBytes) {
    void response.body.cancel().catch(() => {});
    throw new Error("RESPONSE_TOO_LARGE");
  }
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let body = "", bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      bytes += value?.byteLength ?? 0;
      if (bytes > maxBytes) throw new Error("RESPONSE_TOO_LARGE");
      body += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (done) return JSON.parse(body);
    }
  } finally { signal.removeEventListener("abort", cancel); cancel(); reader.releaseLock(); }
}
