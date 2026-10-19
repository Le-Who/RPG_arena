import { AsyncLocalStorage } from "node:async_hooks";
import { Client, Pool, type ClientConfig, type PoolClient, type PoolConfig } from "pg";

/** Totals may overlap across concurrent acquisitions. Acquisition includes queue
 * and connection setup; connect measures successful physical setup only.
 * acquisitions counts attempts (including failures), newConnections successes.
 * maxQueue is the largest pool-wide queue beyond available idle clients observed
 * by this request's attempts (pg also briefly queues immediately reusable clients). */
export type DatabaseTiming = { acquireMs: number; connectMs: number; acquisitions: number; newConnections: number; maxQueue: number };
type TimingScope = { timing: DatabaseTiming; active: boolean };
// Next can bundle callers and database modules separately. Share only the timing
// scope, not pool lifecycle/configuration, across copies within this JS context.
const timingGlobal = globalThis as typeof globalThis & { __chronicleDatabaseTiming?: AsyncLocalStorage<TimingScope> };
const scope = timingGlobal.__chronicleDatabaseTiming ??= new AsyncLocalStorage<TimingScope>();
type ConnectCallback = Parameters<Pool["connect"]>[0];

export function createDatabasePool(config: PoolConfig): Pool {
  const connections = new WeakMap<object, { started: number; connected?: number; reported: boolean }>();
  // pg-pool passes its configuration to Client; @types/pg declares this injectable
  // constructor without arguments even though the driver's constructor accepts it.
  const BaseClient = (config.Client ?? Client) as typeof Client;
  class TimedClient extends BaseClient {
    constructor(options?: string | ClientConfig) {
      const started = performance.now();
      super(options);
      connections.set(this, { started, reported: false });
    }
  }
  class TimedPool extends Pool {
    override connect(): Promise<PoolClient>;
    override connect(callback: ConnectCallback): void;
    override connect(callback?: ConnectCallback): Promise<PoolClient> | void {
      const current = scope.getStore();
      const started = performance.now();
      const observeQueue = () => {
        if (current?.active) current.timing.maxQueue = Math.max(current.timing.maxQueue, this.waitingCount - this.idleCount);
      };
      if (current?.active) current.timing.acquisitions++;
      observeQueue();
      let finished = false;
      const finish = (client?: PoolClient) => {
        if (finished) return;
        finished = true;
        const physical = client ? connections.get(client) : undefined;
        // Attribute a new socket to its first actual borrower. A queued request's
        // client can be constructed while a different request releases a client.
        const isNew = physical && physical.connected !== undefined && !physical.reported;
        if (isNew) physical.reported = true;
        if (!current?.active) return;
        current.timing.acquireMs += Math.max(0, performance.now() - started);
        if (isNew) {
          current.timing.newConnections++;
          current.timing.connectMs += Math.max(0, physical.connected! - physical.started);
        }
      };
      if (callback) {
        try {
          super.connect((error, client, release) => { finish(client); callback(error, client, release); });
          observeQueue();
        } catch (error) { finish(); throw error; }
        return;
      }
      try {
        const pending = super.connect();
        observeQueue();
        return pending.then(client => { finish(client); return client; }, error => { finish(); throw error; });
      } catch (error) { finish(); throw error; }
    }
  }
  const pool = new TimedPool({ ...config, Client: TimedClient });
  pool.on("connect", (client: PoolClient) => {
    const physical = connections.get(client);
    if (physical) physical.connected = performance.now();
  });
  return pool;
}

/** Preserve errors from run; callers that need error-response timings catch inside
 * run. Returned snapshots cannot be changed by later detached/streamed work. */
export async function withDatabaseTiming<T>(run: () => Promise<T>): Promise<{ value: T; timing: DatabaseTiming }> {
  const current: TimingScope = { active: true, timing: { acquireMs: 0, connectMs: 0, acquisitions: 0, newConnections: 0, maxQueue: 0 } };
  try {
    const value = await scope.run(current, run);
    return { value, timing: { ...current.timing } };
  } finally { current.active = false; }
}

export function formatDatabaseTiming(timing: DatabaseTiming) {
  const duration = (value: number) => (Number.isFinite(value) ? Math.max(0, value) : 0).toFixed(1);
  const count = (value: number) => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return {
    serverTiming: `db_acquire;dur=${duration(timing.acquireMs)}, db_connect;dur=${duration(timing.connectMs)}`,
    pool: `acq=${count(timing.acquisitions)};new=${count(timing.newConnections)};queue=${count(timing.maxQueue)}`,
  };
}
