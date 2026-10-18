import test from "node:test";
import assert from "node:assert/strict";
import { callTextWithConfig } from "../src/lib/text-provider";

const config = { textProvider: "openrouter" as const, textApiKey: "synthetic-key" };
const options = { keys: [], models: ["selected/model"], system: "system", user: "user" };
const success = () => Response.json({ choices: [{ message: { content: "answer" }, finish_reason: "stop" }] });

test("external cancellation settles even when fetch ignores its signal and cancels a late response", async t => {
  let release!: (response: Response) => void, entered!: () => void, cancelled = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(globalThis, "fetch", () => { entered(); return new Promise<Response>(resolve => { release = resolve; }); });
  const controller = new AbortController();
  const pending = callTextWithConfig(config, { ...options, signal: controller.signal });
  await started;
  controller.abort(new Error("USER_CANCELLED"));
  const result = await Promise.race([
    pending.then(() => "resolved", error => (error as Error).message),
    new Promise<string>(resolve => setTimeout(() => resolve("STILL_PENDING"), 100)),
  ]);
  release(new Response(new ReadableStream({ cancel() { cancelled++; } })));
  await pending.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result, "USER_CANCELLED");
  assert.equal(cancelled, 1);
});

test("external success telemetry cannot hold the provider deadline open", async t => {
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(globalThis, "fetch", async () => success());
  const pending = callTextWithConfig(config, { ...options, timeoutMs: 260, onAttempt: () => {
    entered(); return new Promise<void>(resolve => { release = resolve; });
  } });
  await started;
  const result = await Promise.race([
    pending.then(() => "resolved", error => (error as Error).message),
    new Promise<string>(resolve => setTimeout(() => resolve("STILL_PENDING"), 400)),
  ]);
  release();
  await pending.catch(() => {});
  assert.equal(result, "AI_DEADLINE:TIMEOUT");
});

test("external provider token usage rejects fractions and unsafe integers before accounting", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({
    choices: [{ message: { content: "answer" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0.5, completion_tokens: Number.MAX_SAFE_INTEGER + 1,
      completion_tokens_details: { reasoning_tokens: 0.25 }, prompt_tokens_details: { cached_tokens: -1 } },
  }));
  let logged: { promptTokens?: number; completionTokens?: number } | undefined;
  const result = await callTextWithConfig(config, { ...options, onAttempt: info => { logged = info; } });
  assert.equal(result.promptTokens, 3);
  assert.equal(result.completionTokens, 2);
  assert.equal(result.thoughtTokens, 0);
  assert.equal(result.cachedTokens, 0);
  assert.equal(logged?.promptTokens, 3);
  assert.equal(logged?.completionTokens, 2);
});
