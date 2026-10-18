import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountsDb } from "./helpers/accounts-db";
import { embedTexts } from "../src/lib/embeddings";
import { pool } from "../src/db";

test("embedding provider deadlines cover fetch, body and accounting", async t => {
  const fixture = await accountsDb();
  const sessionId = randomUUID(), ownerId = "synthetic-deadline-owner";
  await fixture.pg.query("INSERT INTO ai_settings(id,keys) VALUES ($1,'[]')", [ownerId]);
  await fixture.pg.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,$2,'deadline','{}','{}')", [sessionId, ownerId]);
  const options = { sessionId, keys: ["synthetic-key"], model: "gemini-embedding-2", dims: 128, texts: ["query"], timeoutMs: 5000 };
  try {
    await t.test("a fetch that ignores abort cannot hold the embedding deadline", async t => {
      const controller = new AbortController();
      t.mock.method(AbortSignal, "timeout", () => controller.signal);
      let release!: (response: Response) => void, entered!: () => void, cancelled = 0;
      const started = new Promise<void>(resolve => { entered = resolve; });
      t.mock.method(globalThis, "fetch", () => { entered(); return new Promise<Response>(resolve => { release = resolve; }); });
      const pending = embedTexts(options);
      await started; controller.abort();
      const result = await Promise.race([pending.then(() => "resolved", error => (error as Error).message), new Promise<string>(resolve => setTimeout(() => resolve("STILL_PENDING"), 100))]);
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      release(new Response(new ReadableStream({ start(value) { stream = value; }, cancel() { cancelled++; } })));
      if (result === "STILL_PENDING") stream.close();
      await pending.catch(() => {});
      await new Promise(resolve => setImmediate(resolve));
      assert.match(result, /вовремя/);
      assert.equal(cancelled, 1);
    });
    await t.test("a stalled embedding response body is cancelled at the deadline", async t => {
      const controller = new AbortController();
      t.mock.method(AbortSignal, "timeout", () => controller.signal);
      let stream!: ReadableStreamDefaultController<Uint8Array>, entered!: () => void, cancelled = 0;
      const started = new Promise<void>(resolve => { entered = resolve; });
      t.mock.method(globalThis, "fetch", async () => { entered(); return new Response(new ReadableStream({ start(value) { stream = value; }, cancel() { cancelled++; } })); });
      const pending = embedTexts(options);
      await started; await new Promise(resolve => setImmediate(resolve)); controller.abort();
      const result = await Promise.race([pending.then(() => "resolved", error => (error as Error).message), new Promise<string>(resolve => setTimeout(() => resolve("STILL_PENDING"), 100))]);
      if (result === "STILL_PENDING") stream.close();
      await pending.catch(() => {});
      assert.match(result, /вовремя/);
      assert.equal(cancelled, 1);
    });
    for (const outcome of ["success", "network failure"] as const) await t.test(`stalled ${outcome} telemetry cannot extend the embedding deadline or duplicate accounting`, async t => {
      const telemetrySessionId = randomUUID();
      await fixture.pg.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,$2,'telemetry','{}','{}')", [telemetrySessionId, ownerId]);
      const controller = new AbortController();
      t.mock.method(AbortSignal, "timeout", () => controller.signal);
      const vector = [1, ...Array<number>(127).fill(0)];
      t.mock.method(globalThis, "fetch", async () => {
        if (outcome === "network failure") throw new Error("synthetic network failure");
        return Response.json({ embedding: { values: vector } });
      });
      const run = pool.query.bind(pool);
      let release!: () => void, entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      t.mock.method(pool, "query", (async (...args: unknown[]) => {
        const query = args[0] as string | { text: string; values?: unknown[] };
        const values = args[1] ?? (typeof query === "string" ? undefined : query.values);
        if ((typeof query === "string" ? query : query.text).startsWith('insert into "token_logs"') && Array.isArray(values) && values.includes(telemetrySessionId)) {
          entered(); await new Promise<void>(resolve => { release = resolve; });
        }
        return (run as (...args: unknown[]) => unknown)(...args);
      }) as never);
      const pending = embedTexts({ ...options, sessionId: telemetrySessionId });
      await started; controller.abort();
      const result = await Promise.race([pending.then(() => "resolved", error => (error as Error).message), new Promise<string>(resolve => setTimeout(() => resolve("STILL_PENDING"), 100))]);
      release(); await pending.catch(() => {});
      await new Promise(resolve => setImmediate(resolve));
      assert.match(result, /вовремя/);
      const logs = await fixture.pg.query<{ n: number }>("SELECT count(*)::int AS n FROM token_logs WHERE session_id=$1", [telemetrySessionId]);
      assert.equal(logs.rows[0].n, 1);
    });
    await t.test("oversized otherwise valid embedding JSON is rejected before accepting vectors", async t => {
      t.mock.method(globalThis, "fetch", async () => Response.json({
        embedding: { values: [1, ...Array<number>(127).fill(0)] }, ignored: "x".repeat(16 * 1024 * 1024),
      }));
      await assert.rejects(embedTexts(options), /Некорректный ответ сервиса эмбеддингов/);
    });
    const quota = await fixture.pg.query<{ attempts: number }>("SELECT attempts FROM model_call_quotas WHERE owner_id=$1 AND model='gemini-embedding-2'", [ownerId]);
    assert.equal(quota.rows[0].attempts, 5);
  } finally { await fixture.close(); }
});
