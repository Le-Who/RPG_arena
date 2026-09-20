import test from "node:test";
import assert from "node:assert/strict";
import { boundedNarrativeDiagnostic } from "../src/lib/narrative-diagnostics";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("diagnostic payloads omit credential fields, bound details and disclose truncation", () => {
  const value = boundedNarrativeDiagnostic({ decision: "blocked", nested: { apiKey: "secret", authorization: "Bearer secret", keys: ["secret"], text: "x".repeat(13000) } });
  assert.ok(!JSON.stringify(value).includes("secret"));
  assert.equal(value.truncated, true);
  const large = boundedNarrativeDiagnostic({ decision: "blocked", reason: "invalid_review", states: Array.from({ length: 90 }, () => "я".repeat(10000)) });
  assert.equal(large.detailedPayloadOmitted, true);
  assert.equal(large.decision, "blocked");
  assert.ok(Buffer.byteLength(JSON.stringify(large)) < 256000);
});

test("diagnostic migration permits repeated request attempts and deletes private history with campaign", async () => {
  const pg = new PGlite();
  const session = "00000000-0000-4000-8000-000000000001";
  try {
    await pg.exec("CREATE TABLE game_sessions(id uuid PRIMARY KEY)");
    await pg.exec(await readFile("drizzle/0010_narrative_diagnostics.sql", "utf8"));
    await pg.query("INSERT INTO game_sessions VALUES($1)", [session]);
    for (const n of [2, 3]) await pg.query("INSERT INTO narrative_attempts(id,session_id,request_id,turn_number,outcome,payload) VALUES($1,$2,'same-request',2,'failed',$3)",
      [`00000000-0000-4000-8000-00000000000${n}`, session, JSON.stringify({ decision: "blocked", reason: "invalid_review" })]);
    assert.equal((await pg.query("SELECT * FROM narrative_attempts")).rows.length, 2);
    await pg.query("DELETE FROM game_sessions WHERE id=$1", [session]);
    assert.equal((await pg.query("SELECT * FROM narrative_attempts")).rows.length, 0);
  } finally { await pg.close(); }
});
