/** Keep the deadline signal strongly reachable until the complete response is read. */
export async function readResponseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error("EMPTY_RESPONSE");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let body = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      body += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (done) return JSON.parse(body);
    }
  } finally { signal.removeEventListener("abort", cancel); cancel(); reader.releaseLock(); }
}
