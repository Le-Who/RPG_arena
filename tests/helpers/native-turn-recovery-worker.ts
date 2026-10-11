// Test-only process boundary. No dotenv, live transport, or production lifecycle changes.
import "./test-environment";
import assert from "node:assert/strict";
import type { TurnInput } from "../../src/lib/turn-contract";
import type { AIConfig } from "../../src/lib/ai-settings";

const schema = process.argv[2], application = process.argv[3];
assert.equal(process.env.CHRONICLE_RUN_TURN_RECOVERY_POSTGRES, "1");
assert.match(schema, /^turn_recovery_[a-f0-9]{32}$/);
assert.match(application, /^turn_recovery_worker_[a-f0-9]{32}$/);
for (const name of Object.keys(process.env)) if (name.startsWith("PG")) delete process.env[name];
const url = new URL("postgresql://chronicle_test:fixture-only@127.0.0.1:55439/chronicle_auth_test");
url.searchParams.set("options", `-csearch_path=${schema},public -cstatement_timeout=15000`);
url.searchParams.set("application_name", application);
process.env.DATABASE_URL = url.toString();

const config: AIConfig = {
  keys: ["synthetic-recovery-provider"], dbKeyCount: 1, envKeyCount: 0, useLiveAI: true, canUseLive: true,
  routingConfig: { profile: "balanced", narrationModel: "gemini-3.5-flash-lite", customActionModel: "gemini-3.8-flash", compactionModel: "gemini-3.8-flash", fastTaskModel: "gemini-3.5-flash-lite" },
  limits: { flash: 20, lite: 500 }, enforceLimits: true,
  embeddingsEnabled: false, embeddingModel: "gemini-embedding-2", embeddingDims: 768, semanticExtractionEnabled: true,
};
let resume: (() => void) | undefined;
let narration = "";
let providerCalls = 0;
globalThis.fetch = async (input, init) => {
  const endpoint = new URL(String(input));
  assert.equal(endpoint.hostname, "generativelanguage.googleapis.com");
  assert.match(endpoint.pathname, /^\/v1beta\/models\/gemini-[^/]+:generateContent$/);
  assert.equal(init?.method, "POST");
  assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "synthetic-recovery-provider");
  providerCalls++;
  await new Promise<void>(resolve => {
    resume = resolve;
    process.send?.({ kind: "provider", calls: providerCalls });
  });
  return Response.json({
    candidates: [{ content: { parts: [{ text: JSON.stringify({
      outcome: "success", effects: { hp: 0, xp: 10, gold: 0, danger: 0 },
      stateChanges: {
        location: null, locations: [], routes: [], quests: [], npcs: [], inventory: [],
        sceneObjects: [{ ref: "", name: "Тумба", state: "осмотрена", note: "Каменная тумба на причале." }],
        conditions: { add: [], remove: [] }, flags: { inspected: true },
      }, choices: ["Продолжить прогулку"], narration,
    }) }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 },
  });
};

async function main() {
  const { pool } = await import("../../src/db");
  let stopping = false;
  pool.on("remove", () => { if (!stopping && process.connected) process.send?.({ kind: "removed" }); });
  const { performTurn } = await import("../../src/lib/turn");
  let started = false;
  process.on("message", async (message: { kind: string; input?: TurnInput; rng?: number; narration?: string }) => {
    if (message.kind === "release") { resume?.(); return; }
    if (message.kind === "stop") { stopping = true; await pool.end(); process.disconnect?.(); return; }
    if (message.kind === "probe") {
      const row = (await pool.query("SELECT pg_backend_pid() AS pid, 6*7 AS answer")).rows[0];
      process.send?.({ kind: "probe", backendPid: row.pid, answer: row.answer }); return;
    }
    assert.equal(message.kind, "run");
    assert.equal(started, false);
    started = true;
    assert.ok(message.input);
    assert.ok(message.rng === .6 || message.rng === 0);
    Math.random = () => message.rng!;
    narration = message.narration!;
    try {
      const result = await performTurn(message.input, {
        loadAIConfig: async () => config,
        loadNarrativeConfig: async () => ({ enabled: false, provider: "openrouter", apiKey: "" }),
        schedule() {}, scheduleDiagnostics() {},
      });
      process.send?.({ kind: "result", result, providerCalls });
    } catch (error) {
      // Match the public INTERNAL failure category without transporting raw SQL/errors.
      assert.ok(error instanceof Error);
      process.send?.({ kind: "failure", code: "INTERNAL", providerCalls });
    }
  });
  process.send?.({ kind: "ready", pid: process.pid });
}
main().catch(error => { console.error(error instanceof Error ? error.name : "WorkerError"); process.exitCode = 1; process.disconnect?.(); });
