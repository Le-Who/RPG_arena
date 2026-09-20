import type { TurnRuntime } from "./turn";
import type { TurnError, TurnResponse } from "./turn-contract";
import type { TurnEvent } from "./turn-stream";
import { HttpError } from "./http";

const failure = (error: unknown): TurnError => error instanceof HttpError
  ? { ok: false, code: error.code as TurnError["code"], message: error.message, ...error.extra }
  : { ok: false, code: "INTERNAL", message: "Не удалось завершить запрос. Проверяем сохранение хода; действие не нужно отправлять заново." };
const status = (r: TurnError) => r.code === "NOT_FOUND" ? 404 : r.code === "BUSY" ? 429 : r.code === "INVALID_INPUT" ? 400 : r.code === "AI_FAILED" ? 503 : r.code === "INTERNAL" ? 500 : 409;

/** The ledger owns completion. Disconnecting the display never cancels an admitted turn. */
export async function turnHttpResponse(streaming: boolean, run: (runtime: TurnRuntime) => Promise<TurnResponse | TurnError>, after: (job: () => Promise<void>) => void): Promise<Response> {
  const jobs: (() => Promise<void>)[] = [];
  const runtime: TurnRuntime = { schedule: job => { jobs.push(job); } };
  if (!streaming) {
    const result = await run(runtime).catch(failure);
    after(async () => { await Promise.allSettled(jobs.map(job => job())); });
    const headers: Record<string,string> = { "Cache-Control": "no-store" };
    if (result.ok) headers["Server-Timing"] = Object.entries(result.timings ?? {}).filter(([name,value]) => name.endsWith("Ms") && Number.isFinite(value)).map(([name,value]) => `${name.slice(0,-2)};dur=${value}`).join(", ");
    else if (result.retryAfter) headers["Retry-After"] = String(result.retryAfter);
    return Response.json(result, { status: result.ok ? 200 : status(result), headers });
  }
  let connected = true;
  let work: Promise<void> = Promise.resolve();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: TurnEvent) => { if (connected) { try { controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`)); } catch { connected=false; } } };
      work = (async () => {
        const result = await run({ ...runtime, onEvent: send }).catch(failure);
        send(result.ok ? { type: "committed", result } : { type: "error", error: result });
        if (connected) { connected=false; controller.close(); }
      })();
    },
    cancel() { connected=false; },
  });
  // Register in request scope now; a streamed response may already be disconnected later.
  after(async () => { await work; await Promise.allSettled(jobs.map(job => job())); });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
}
