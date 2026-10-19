import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("production module reloads reuse one pool, attach its platform lifecycle once and retain error guards", () => {
  const script = `
    const assert = require("node:assert/strict");
    const Module = require("node:module");
    const attached = [];
    const originalLoad = Module._load;
    // Only the platform lifecycle boundary is replaced. Import and reload the
    // actual database module with the real pg Pool and its diagnostic subclass.
    Module._load = function(name, ...args) {
      if (name === "@vercel/functions/db-connections") return { attachDatabasePool: pool => attached.push(pool) };
      return Reflect.apply(originalLoad, this, [name, ...args]);
    };
    const id = require.resolve("./src/db/index.ts");
    const first = require(id).pool;
    const listeners = ["error", "connect", "acquire"].map(name => first.listenerCount(name));
    delete require.cache[id];
    const second = require(id).pool;
    delete require.cache[id];
    const third = require(id).pool;
    (async () => {
      try {
        assert.equal(first === second && second === third, true, "production module copies must share one pool");
        assert.equal(attached.length, 1, "attachDatabasePool is registered once across module reloads");
        assert.equal(attached[0] === first, true, "the actual shared pool is attached");
        assert.deepEqual(["error", "connect", "acquire"].map(name => first.listenerCount(name)), listeners, "module reloads do not duplicate error guards");
        assert.equal(first.listenerCount("error"), 1);
        console.log("production lifecycle preserved");
      } finally { for (const pool of new Set([first, second, third])) await pool.end(); }
    })().catch(error => { console.error(error.message); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--import", "./tests/helpers/test-environment.ts", "--input-type=commonjs", "--eval", script], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: "production" }, encoding: "utf8", timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /production lifecycle preserved/);
});

test("production pool bounds acquisition while retaining idle eviction and unbounded transaction queries", async () => {
  const { pool } = await import("../src/db");
  assert.equal(pool.options.max, 10);
  assert.equal(pool.options.min, 0);
  assert.equal(pool.options.idleTimeoutMillis, 10000);
  assert.equal(pool.options.connectionTimeoutMillis, 10000, "connect and pool queue waits are bounded");
  assert.equal(pool.options.statement_timeout, undefined, "long transaction SQL retains its existing policy");
  assert.equal(pool.options.query_timeout, undefined, "no client query timeout can interrupt a committed action");
});
