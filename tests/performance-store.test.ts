import test from "node:test";
import assert from "node:assert/strict";
import { accountsDb } from "./helpers/accounts-db";
import { parseVitalBatch } from "../src/lib/performance-report";
import { recordVitalSamples, loadPerformanceReport } from "../src/lib/performance-store";
import { POST } from "../src/app/api/telemetry/vitals/route";
import { cookieContext } from "./helpers/accounts-db";
import { GET } from "../src/app/api/system/performance/route";

const sample = parseVitalBatch({ samples: [{ metric: "LCP", value: 100, route: "/play/private-id" }] }).samples;
test("telemetry is disabled by default without reading body or reaching the database", async () => {
  delete process.env.CHRONICLE_TELEMETRY_ENABLED;
  const response = await POST(new Request("https://test/api/telemetry/vitals", { method: "POST", body: "not json" }));
  assert.equal(response.status, 204);
  assert.equal(await recordVitalSamples(sample), 0);
});

test("telemetry store prunes old rows, bounds admission across calls, and reports bounded samples", async () => {
  const fixture = await accountsDb();
  process.env.CHRONICLE_TELEMETRY_ENABLED = "1";
  try {
    await fixture.pg.query("INSERT INTO performance_samples(metric,route,value,created_at) VALUES('LCP','/',1,now()-interval '15 days')");
    assert.equal(await recordVitalSamples(sample), 1);
    const result = await fixture.pg.query<{route:string}>("SELECT route FROM performance_samples");
    assert.deepEqual(result.rows, [{ route: "/play/[id]" }]);
    const concurrent = await Promise.all(Array.from({ length: 20 }, () => recordVitalSamples(sample)));
    assert.equal(concurrent.reduce((sum, count) => sum + count, 0), 1, "optional ingestion drops concurrent work instead of filling the shared pool queue");
    // Global database quota remains effective even after a new process's local bucket resets.
    await fixture.pg.query("INSERT INTO performance_samples(metric,route,value) SELECT 'LCP','/',1 FROM generate_series(1,600)");
    assert.equal(await recordVitalSamples(sample), 0);
    const report = await loadPerformanceReport(999);
    assert.equal(report.windowDays, 14);
    assert.equal(report.telemetryEnabled, true);
    assert.equal(report.sampleLimit, 20000);
    await fixture.pg.query("UPDATE performance_samples SET created_at=now()-interval '2 minutes'");
    await fixture.pg.query("INSERT INTO performance_samples(metric,route,value,created_at) SELECT 'LCP','/',1,now()-interval '2 minutes' FROM generate_series(1,20000)");
    assert.equal(await recordVitalSamples(sample), 1);
    assert.equal((await fixture.pg.query<{ n: number }>("SELECT count(*)::int AS n FROM performance_samples")).rows[0].n, 20000);
  } finally { delete process.env.CHRONICLE_TELEMETRY_ENABLED; await fixture.close(); }
});

test("performance report denies unauthenticated visitors before database reads", async () => {
  const response = await cookieContext("", () => GET(new Request("https://test/api/system/performance")));
  assert.equal(response.status, 403);
});

test("enabled telemetry rejects oversized and malformed bodies before database writes", async () => {
  process.env.CHRONICLE_TELEMETRY_ENABLED = "1";
  try {
    const request = (body: string) => new Request("https://test/api/telemetry/vitals", { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal((await POST(request(JSON.stringify({ samples: [], pad: "x".repeat(9000) })))).status, 413);
    assert.equal((await POST(request('{"samples":"wrong"}'))).status, 400);
    assert.equal((await POST(request('{"samples":[{"metric":"constructor","value":1}]}'))).status, 204);
  } finally { delete process.env.CHRONICLE_TELEMETRY_ENABLED; }
});
