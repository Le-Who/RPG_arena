// Explicit opt-in; fixed loopback synthetic fixture only, never .env/provider keys.
import "../helpers/test-environment";
import test from "node:test";
import assert from "node:assert/strict";
import { performancePostgresFixture, telemetryBarrier, boundedTelemetry } from "../helpers/performance-postgres-fixture";
import type { VitalSample } from "../../src/lib/performance-report";

const sample: VitalSample = { metric: "LCP", route: "/play/[id]", value: 100, rating: "good", device: "desktop", navigationType: "navigate" };

test("native telemetry module instances release admission and share the rolling-minute cap", {
  skip: process.env.CHRONICLE_RUN_PERFORMANCE_POSTGRES !== "1", timeout: 60000,
}, async t => {
  const fixture = await performancePostgresFixture();
  process.env.CHRONICLE_TELEMETRY_ENABLED = "1";
  try {
    assert.equal((await fixture.control.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname=$1", [fixture.schema])).rows[0].n, 1);
    await t.test("busy native transaction lock drops ingestion and releases client plus module recording flag", async () => {
      const pids = new Set<number>();
      const reporter = await fixture.reporter(async (_sql, _phase, pid) => { pids.add(pid); });
      const blocker = await fixture.control.connect();
      let blockedPid = 0;
      try {
        await blocker.query("BEGIN");
        blockedPid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        await blocker.query("SELECT pg_advisory_xact_lock(271018)");
        assert.equal(await boundedTelemetry(reporter.module.recordVitalSamples([sample]), "busy telemetry lock returns without waiting"), 0);
        assert.equal((await blocker.query("SELECT count(*)::int AS n FROM performance_samples")).rows[0].n, 0);
        assert.equal(reporter.pool.idleCount, 1);
        assert.equal(reporter.pool.totalCount, 1);
        assert.equal(reporter.pool.waitingCount, 0);
      } finally { await blocker.query("ROLLBACK"); blocker.release(); }
      assert.equal(pids.size, 1);
      assert.equal(pids.has(blockedPid), false, "blocker and ingestion are independent native connections");
      assert.equal(await reporter.module.recordVitalSamples([sample]), 1);
      assert.equal((await fixture.control.query("SELECT count(*)::int AS n FROM performance_samples")).rows[0].n, 1);
    });

    await t.test("real SQL constraint failure rolls back pruning and releases lock client and recording flag", async () => {
      await fixture.control.query("TRUNCATE performance_samples");
      await fixture.control.query("INSERT INTO performance_samples(metric,route,value,created_at) VALUES ('LCP','/',7,now()-interval '15 days')");
      const reporter = await fixture.reporter();
      await assert.rejects(reporter.module.recordVitalSamples([{ ...sample, value: -1 }]), { code: "23514" });
      assert.deepEqual((await fixture.control.query("SELECT route,value FROM performance_samples")).rows, [{ route: "/", value: 7 }]);
      assert.equal(reporter.pool.idleCount, 1);
      assert.equal(reporter.pool.totalCount, 1);
      assert.equal(reporter.pool.waitingCount, 0);
      const probe = await fixture.control.connect();
      try {
        await probe.query("BEGIN");
        assert.equal((await probe.query("SELECT pg_try_advisory_xact_lock(271018) AS locked")).rows[0].locked, true);
      } finally { await probe.query("ROLLBACK"); probe.release(); }
      assert.equal(await reporter.module.recordVitalSamples([sample]), 1);
      assert.deepEqual((await fixture.control.query("SELECT route,value FROM performance_samples")).rows, [{ route: "/play/[id]", value: 100 }]);
    });

    await t.test("two reporter module instances on independent connections persist at most literal 600 per minute", async () => {
      await fixture.control.query("TRUNCATE performance_samples");
      await fixture.control.query("INSERT INTO performance_samples(metric,route,value) SELECT 'LCP','/',1 FROM generate_series(1,570)");
      const gate = telemetryBarrier();
      let held = false, firstPid = 0, secondPid = 0;
      const first = await fixture.reporter(async (sql, phase, pid) => {
        firstPid = pid;
        if (!held && phase === "after" && sql.startsWith("SELECT count(*) FROM performance_samples")) { held = true; await gate.hold(); }
      });
      const second = await fixture.reporter(async (_sql, _phase, pid) => { secondPid = pid; });
      const batch = Array.from({ length: 20 }, () => ({ ...sample }));
      const pending = first.module.recordVitalSamples(batch);
      void pending.catch(() => undefined);
      let persisted = 0;
      try {
        await boundedTelemetry(gate.entered, "first reporter holds actual lock after its quota read");
        assert.equal(await boundedTelemetry(second.module.recordVitalSamples(batch), "second module drops busy ingestion"), 0);
        assert.notEqual(firstPid, secondPid);
        assert.equal((await fixture.control.query("SELECT count(*)::int AS n FROM performance_samples")).rows[0].n, 570);
        assert.equal(second.pool.idleCount, 1);
      } finally {
        gate.release();
        persisted = await boundedTelemetry(pending, "first reporter commits");
      }
      assert.equal(persisted, 20);
      const secondAdmission = await second.module.recordVitalSamples(batch);
      assert.equal((await fixture.control.query("SELECT count(*)::int AS n FROM performance_samples WHERE created_at>=now()-interval '1 minute'")).rows[0].n, 600);
      assert.equal(secondAdmission, 10);
      assert.equal(await first.module.recordVitalSamples([sample]), 0);
      assert.equal(await second.module.recordVitalSamples([sample]), 0);
      assert.equal((await fixture.control.query("SELECT count(*)::int AS n FROM performance_samples")).rows[0].n, 600);
      await fixture.control.query("UPDATE performance_samples SET created_at=now()-interval '2 minutes'");
      assert.equal(await second.module.recordVitalSamples([sample]), 1, "same instance recovers after the database minute window clears");
      assert.equal((await fixture.control.query("SELECT count(*)::int AS n FROM performance_samples WHERE created_at>=now()-interval '1 minute'")).rows[0].n, 1);
      t.diagnostic(`distinct reporter module instances in one process; native backend PIDs ${firstPid} and ${secondPid}; minimal migration0018 fixture`);
    });
  } finally { delete process.env.CHRONICLE_TELEMETRY_ENABLED; await fixture.close(); }
});
