// Test-only process: real worker/SQL, synthetic provider transport gated by parent IPC.
import "./test-environment";
import assert from "node:assert/strict";

const url = new URL(process.argv[2]);
assert.equal(url.hostname, "127.0.0.1");
assert.equal(url.port, "55439");
assert.equal(url.pathname, "/chronicle_auth_test");
assert.equal(url.username, "chronicle_test");
assert.match(url.searchParams.get("options") ?? "", /^-csearch_path=queue_p1_[0-9a-f]{32},public /);
for (const name of Object.keys(process.env)) if (name.startsWith("PG")) delete process.env[name];
process.env.DATABASE_URL = url.toString();
process.env.CHRONICLE_SECRET_ACTIVE_KEY = "queue-fixture";
process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ "queue-fixture": Buffer.alloc(32, 17).toString("base64") });

const release = new Map<number, () => void>();
let sequence = 0;
let stopping = false;
globalThis.fetch = async (input, init) => {
  const endpoint = new URL(String(input));
  assert.equal(endpoint.hostname, "generativelanguage.googleapis.com");
  assert.equal(init?.method, "POST");
  const key = new Headers(init?.headers).get("x-goog-api-key");
  assert.ok(key === "queue-synthetic-A" || key === "queue-synthetic-B");
  const owner = key.endsWith("A") ? "A" : "B";
  const body = JSON.parse(String(init?.body));
  const task = endpoint.pathname.endsWith(":embedContent") ? "embedding" : "semantic";
  if (task === "semantic") assert.match(endpoint.pathname, /^\/v1beta\/models\/gemini-[^/]+:generateContent$/);
  else {
    assert.equal(endpoint.pathname, "/v1beta/models/gemini-embedding-2:embedContent");
    assert.equal(body.outputDimensionality, 128);
  }
  const id = ++sequence;
  if (!stopping) await new Promise<void>((resolve, reject) => {
    const abort = () => { release.delete(id); reject(init?.signal?.reason); };
    release.set(id, () => { init?.signal?.removeEventListener("abort", abort); release.delete(id); resolve(); });
    init?.signal?.addEventListener("abort", abort, { once: true });
    init?.signal?.throwIfAborted();
    process.send?.({ kind: "provider", id, owner, task });
  });
  return task === "semantic"
    ? Response.json({ candidates: [{ content: { parts: [{ text: '{"facts":[]}' }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } })
    : Response.json({ embedding: { values: Array.from({ length: 128 }, (_, i) => i === 0 ? 1 : owner === "A" ? .5 : .25) } });
};

async function main() {
const { pool } = await import("../../src/db");
const { runMemoryCycle } = await import("../../src/lib/background");
let busy = false;
let activeTick: Promise<void> | undefined;
process.on("message", async (message: { kind: string; id?: number }) => {
  if (message.kind === "release") { release.get(message.id!)?.(); return; }
  if (message.kind === "stop") {
    stopping = true;
    for (const resume of release.values()) resume();
    await activeTick;
    await pool.end(); process.disconnect?.(); return;
  }
  if (message.kind !== "tick" || busy) throw new Error("INVALID_WORKER_COMMAND");
  busy = true;
  activeTick = (async () => {
  try { process.send?.({ kind: "report", report: await runMemoryCycle({ source: "worker" }) }); }
  catch (error) { process.send?.({ kind: "error", error: error instanceof Error ? error.name : "UnknownError" }); }
  finally { busy = false; }
  })();
  await activeTick;
});
process.send?.({ kind: "ready", pid: process.pid, backendPid: (await pool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid });
}
main().catch(error => { console.error(error instanceof Error ? error.name : "WorkerError"); process.exitCode = 1; process.disconnect?.(); });
