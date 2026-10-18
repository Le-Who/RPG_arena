import { readResponseJson } from "../../scripts/lib/read-response-json";

async function run() {
  setInterval(() => (globalThis as typeof globalThis & { gc: () => void }).gc(), 10).unref();
  const signal = AbortSignal.timeout(200);
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"unfinished":"synthetic-body')); },
    cancel() { console.log("BODY_CANCELLED"); },
  }));
  console.log("HEADERS_RECEIVED");
  await readResponseJson(response, signal);
  console.log("UNEXPECTED_SUCCESS");
}

const keepAlive = setTimeout(() => {}, 5000);
run().catch(error => { console.log(error instanceof Error ? error.name : "UnknownError"); }).finally(() => { clearTimeout(keepAlive); });
