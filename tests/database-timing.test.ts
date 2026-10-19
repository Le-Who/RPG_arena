import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { PoolConfig } from "pg";
import { createDatabasePool, formatDatabaseTiming, withDatabaseTiming } from "../src/db/pool";

// Exercise the real pg-pool queue, callback API, release and query machinery.
// Only physical network clients are replaced; no real DB or credentials are used.
function physicalClients(failure?: Error) {
  class PhysicalClient extends EventEmitter {
    static created = 0;
    static options: PoolConfig[] = [];
    _queryable = true;
    _ending = false;
    constructor(options: PoolConfig = {}) { super(); PhysicalClient.created++; PhysicalClient.options.push(options); }
    connect(callback: (error?: Error) => void) { setTimeout(() => callback(failure), 15); }
    query(_text: unknown, _values: unknown, callback: (error: Error | null, result: unknown) => void) {
      queueMicrotask(() => callback(null, { rows: [{ ok: true }] }));
    }
    end(callback?: () => void) { this._ending = true; queueMicrotask(() => callback?.()); }
  }
  return PhysicalClient;
}
const clientType = (client: ReturnType<typeof physicalClients>) => client as unknown as NonNullable<PoolConfig["Client"]>;
function gate() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; }

test("pool timing preserves promise/callback reuse and existing lifecycle defaults", async () => {
  const client = physicalClients();
  const pool = createDatabasePool({ Client: clientType(client) });
  try {
    const { value, timing } = await withDatabaseTiming(async () => {
      const borrowed = await pool.connect(); borrowed.release();
      await new Promise<void>((resolve, reject) => pool.connect((error, borrowed, release) => {
        if (error) { reject(error); return; }
        assert.ok(borrowed); release(); resolve();
      }));
      return "preserved result";
    });
    assert.equal(value, "preserved result");
    assert.equal(timing.acquisitions, 2);
    assert.equal(timing.newConnections, 1);
    assert.equal(timing.maxQueue, 0);
    assert.ok(timing.connectMs >= 5, "physical setup is measured separately");
    assert.ok(timing.acquireMs >= timing.connectMs);
    assert.equal(client.created, 1, "callback borrowing reuses the same physical connection");
    assert.equal(pool.options.idleTimeoutMillis, 10000);
    assert.equal(pool.options.max, 10);
    assert.equal(pool.options.min, 0);
    assert.equal(pool.options.connectionTimeoutMillis, undefined);
    assert.equal(client.options[0].max, 10, "the physical constructor receives the driver's original configuration");
    assert.equal(client.options[0].idleTimeoutMillis, 10000);
    const headers = formatDatabaseTiming(timing);
    assert.match(headers.serverTiming, /^db_acquire;dur=\d+\.\d, db_connect;dur=\d+\.\d$/);
    assert.equal(headers.pool, "acq=2;new=1;queue=0");
  } finally { await pool.end(); }
});

test("queued reconnect belongs to the borrower, independently of another request releasing a broken client", async () => {
  const client = physicalClients();
  const pool = createDatabasePool({ Client: clientType(client), max: 1 });
  const borrowed = gate(), release = gate();
  try {
    const first = withDatabaseTiming(async () => {
      const connection = await pool.connect(); borrowed.open();
      await release.promise; connection.release(true);
    });
    await borrowed.promise;
    const second = withDatabaseTiming(async () => { const connection = await pool.connect(); connection.release(); });
    assert.equal(pool.waitingCount, 1);
    release.open();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.timing.acquisitions, 1);
    assert.equal(a.timing.newConnections, 1);
    assert.equal(b.timing.acquisitions, 1);
    assert.equal(b.timing.newConnections, 1, "new socket created while releasing A belongs to queued request B");
    assert.equal(b.timing.maxQueue, 1);
    assert.ok(b.timing.connectMs >= 5);
    assert.ok(b.timing.acquireMs >= b.timing.connectMs);
    assert.equal(client.created, 2);
  } finally { release.open(); await pool.end(); }
});

test("physical connection failures preserve original promise and callback errors without exposing them in headers", async () => {
  const failure = new Error("CONNECTION_SQL_SECRET_SENTINEL");
  const client = physicalClients(failure);
  const pool = createDatabasePool({ Client: clientType(client) });
  try {
    const { timing } = await withDatabaseTiming(async () => {
      await assert.rejects(pool.connect(), error => error === failure);
      await new Promise<void>(resolve => pool.connect((error, connection) => {
        assert.equal(error, failure); assert.equal(connection, undefined); resolve();
      }));
    });
    assert.equal(timing.acquisitions, 2);
    assert.equal(timing.newConnections, 0);
    assert.ok(timing.acquireMs >= 10);
    assert.equal(JSON.stringify(formatDatabaseTiming(timing)).includes("SENTINEL"), false);
    await assert.rejects(() => withDatabaseTiming(async () => { throw failure; }), error => error === failure);
  } finally { await pool.end(); }
});

test("pool.query promise and callback paths are measured without recording SQL or parameters", async () => {
  const client = physicalClients();
  const pool = createDatabasePool({ Client: clientType(client) });
  try {
    const { value, timing } = await withDatabaseTiming(async () => {
      const result = await pool.query("PRIVATE_SQL_SENTINEL", ["PRIVATE_PARAMETER_SENTINEL"]);
      await new Promise<void>((resolve, reject) => pool.query("SECOND_PRIVATE_SQL", (error: Error | null) => error ? reject(error) : resolve()));
      return result.rows;
    });
    assert.deepEqual(value, [{ ok: true }]);
    assert.equal(timing.acquisitions, 2);
    assert.equal(timing.newConnections, 1);
    assert.equal(/PRIVATE|SQL|PARAMETER/.test(JSON.stringify({ timing, headers: formatDatabaseTiming(timing) })), false);
  } finally { await pool.end(); }
});

test("an unmeasured connection is not reported as new when a later measured request reuses it", async () => {
  const client = physicalClients();
  const pool = createDatabasePool({ Client: clientType(client) });
  try {
    const first = await pool.connect(); first.release();
    const { timing } = await withDatabaseTiming(async () => { const next = await pool.connect(); next.release(); });
    assert.equal(timing.acquisitions, 1);
    assert.equal(timing.newConnections, 0);
    assert.equal(timing.connectMs, 0);
  } finally { await pool.end(); }
});

test("pg-pool queue timeouts preserve both APIs, release their waiter and keep the held connection usable", async () => {
  const client = physicalClients();
  const pool = createDatabasePool({ Client: clientType(client), max: 1, connectionTimeoutMillis: 50, application_name: "diagnostic-fixture" });
  const held = await pool.connect();
  let heldActive = true;
  // Real sockets keep Node alive; the synthetic client needs an equivalent ref
  // because pg deliberately unrefs its pool-wait timeout.
  const socketReference = setInterval(() => {}, 1000);
  try {
    const { timing } = await withDatabaseTiming(async () => {
      await assert.rejects(pool.connect(), /timeout exceeded when trying to connect/);
      await new Promise<void>((resolve, reject) => pool.connect((error, connection) => {
        try { assert.match(error!.message, /timeout exceeded when trying to connect/); assert.equal(connection, undefined); resolve(); }
        catch (failure) { reject(failure); }
      }));
    });
    assert.equal(timing.acquisitions, 2);
    assert.equal(timing.newConnections, 0);
    assert.equal(timing.connectMs, 0);
    assert.equal(timing.maxQueue, 1);
    assert.ok(timing.acquireMs >= 80);
    assert.equal(pool.waitingCount, 0);
    assert.equal(client.options[0].application_name, "diagnostic-fixture");
    assert.equal(client.options[0].connectionTimeoutMillis, 50);
    held.release(); heldActive = false;
    const reused = await pool.connect(); reused.release();
    assert.equal(client.created, 1);
  } finally { clearInterval(socketReference); if (heldActive) held.release(); await pool.end(); }
});
