import test from "node:test";
import assert from "node:assert/strict";
import { databaseLocation, withRequestDiagnostics, measureRequestPhase } from "../src/lib/request-diagnostics";

test("database diagnostics expose only a recognized region and connection mode", () => {
  const location = databaseLocation("postgresql://private-user:private-password@ep-secret-pooler.eu-central-1.aws.neon.tech/private-db?sslmode=require");
  assert.deepEqual(location, { region: "aws-eu-central-1", mode: "pooled" });
  assert.deepEqual(databaseLocation("postgres://secret@private.internal/db"), { region: "unknown", mode: "unknown" });
  assert.deepEqual(databaseLocation("bad secret"), { region: "unknown", mode: "unknown" });
});

test("request phases stay isolated, include rejected work and preserve responses", async () => {
  const [first, second] = await Promise.all([
    withRequestDiagnostics(async () => {
      await measureRequestPhase("identity", async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
      return new Response("first", { status: 201 });
    }),
    withRequestDiagnostics(async () => {
      await assert.rejects(measureRequestPhase("admission", async () => { throw new Error("fixture"); }));
      return new Response("second");
    }),
  ]);
  assert.equal(first.status, 201);
  assert.equal(first.bodyUsed, false);
  assert.match(first.headers.get("Server-Timing")!, /identity;dur=\d+\.\d/);
  assert.doesNotMatch(first.headers.get("Server-Timing")!, /admission/);
  assert.match(second.headers.get("Server-Timing")!, /admission;dur=\d+\.\d/);
  assert.doesNotMatch(second.headers.get("Server-Timing")!, /identity/);
  assert.deepEqual([first.headers.get("X-Chronicle-Instance-First"), second.headers.get("X-Chronicle-Instance-First")], ["1", "0"]);
  assert.equal(first.headers.get("X-Chronicle-Auto-Migrate"), "0");
});
