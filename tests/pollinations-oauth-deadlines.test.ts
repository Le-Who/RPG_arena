import test from "node:test";
import assert from "node:assert/strict";
import { beginPollinationsConnect } from "../src/lib/pollinations-oauth";

const config = { clientId: "pk_test_app", redirectUri: "http://localhost:3000/api/settings/pollinations/callback" };
const keyring = { active: "test", keys: { test: Buffer.alloc(32, 9).toString("base64") } };

test("OAuth discovery deadline cancels a stalled response after headers", async t => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => controller.signal);
  let stream!: ReadableStreamDefaultController<Uint8Array>, cancelled = 0;
  const response = new Response(new ReadableStream({ start(value) { stream = value; }, cancel() { cancelled++; } }));
  const pending = beginPollinationsConnect("synthetic-owner", config, async () => response, keyring);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  const result = await Promise.race([
    pending.then(() => "resolved", error => (error as { code?: string }).code ?? (error as Error).message),
    new Promise<string>(resolve => setTimeout(() => resolve("STILL_PENDING"), 100)),
  ]);
  if (result === "STILL_PENDING") stream.close();
  await pending.catch(() => {});
  assert.equal(result, "POLLINATIONS_CONNECT_INVALID");
  assert.equal(cancelled, 1);
});

test("oversized OAuth discovery is rejected without waiting for upstream cancellation", async () => {
  let release!: () => void, cancelled = 0;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(16385)); },
    cancel() { cancelled++; return new Promise<void>(resolve => { release = resolve; }); },
  }));
  const pending = beginPollinationsConnect("synthetic-owner", config, async () => response, keyring);
  const result = await Promise.race([
    pending.then(() => "resolved", () => "rejected"),
    new Promise<string>(resolve => setTimeout(() => resolve("STILL_PENDING"), 100)),
  ]);
  release();
  await pending.catch(() => {});
  assert.equal(result, "rejected");
  assert.equal(cancelled, 1);
});
