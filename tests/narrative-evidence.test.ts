import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { buildNarrativeEvidenceQuery, snapshotNarrativeEvidence } from "../src/lib/narrative-evidence";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

test("evidence search migration indexes existing text and follows content edits", async () => {
  const pg = new PGlite();
  try {
    await pg.exec("CREATE TABLE game_turns(content text); INSERT INTO game_turns(content) VALUES ('амулет')");
    await pg.exec(await readFile("drizzle/0009_narrative_evidence_search.sql", "utf8"));
    const matches = async () => (await pg.query("SELECT count(*)::int AS n FROM game_turns WHERE evidence_search @@ plainto_tsquery('russian', 'амулет')")).rows[0];
    assert.deepEqual(await matches(), { n: 1 });
    await pg.exec("UPDATE game_turns SET content = 'дорога'");
    assert.deepEqual(await matches(), { n: 0 });
  } finally { await pg.close(); }
});

test("historical evidence retrieves original deal beyond recent history and excludes other campaigns/future", async () => {
  const pg = new PGlite();
  try {
    await pg.exec("CREATE TABLE game_turns(id text, session_id text, turn_number int, role text, content text, state_changes jsonb, context_meta jsonb)");
    await pg.exec(await readFile("drizzle/0009_narrative_evidence_search.sql", "utf8"));
    for (const [id, session, turn, role, content] of [
      ["old", "a", 10, "narrator", "Сделка: вернуть пропажу в обмен на владение вещью."],
      ["intent", "a", 10, "player", "Предложить договор"],
      ["future", "a", 44, "narrator", "Сделка о районе"],
      ["foreign", "b", 10, "narrator", "Сделка о районе"],
      ["recent", "a", 43, "narrator", "Дверь открыта"],
    ]) await pg.query("INSERT INTO game_turns(id, session_id, turn_number, role, content, state_changes, context_meta) VALUES($1,$2,$3,$4,$5,null,null)", [id, session, turn, role, content]);
    const query = buildNarrativeEvidenceQuery({ sessionId: "a", beforeTurn: 44, action: "напомнить про сделку", sourceTurns: [44, 10] });
    const rows = (await pg.query(query.text, query.values)).rows;
    const snapshot = snapshotNarrativeEvidence(rows);
    assert.ok(snapshot.sources.some(s => s.id === "old"));
    assert.ok(snapshot.sources.some(s => s.id === "intent" && s.authority === "intention"));
    assert.ok(!snapshot.sources.some(s => ["future", "foreign"].includes(s.id)));
    assert.equal(snapshot.completeHistory, false);
  } finally { await pg.close(); }
});

test("historical verification authority is bound to exact text and does not survive edits", () => {
  const content = "Тебе отказали в получении штанов.";
  const row = { id: "verified", turn_number: 46, role: "narrator", content, state_changes: { rejected: ["не получен"] },
    verification: { version: 1, textSha256: createHash("sha256").update(content).digest("hex"), checks: [{ status: "rejected" }, { status: "verified" }] } };
  assert.equal(snapshotNarrativeEvidence([row]).sources[0].authority, "verified_narration");
  assert.equal(snapshotNarrativeEvidence([{ ...row, content: "Ты получил штаны." }]).sources[0].authority, "disputed_narration");
  assert.equal(snapshotNarrativeEvidence([{ ...row, verification: { ...row.verification, checks: [] } }]).sources[0].authority, "disputed_narration");
});

test("review authority belongs only to the same final uncertain draft and exact saved text", () => {
  const content = "Мира согласилась на новый срок.";
  const row = { id: "reviewed", turn_number: 4, role: "narrator", content, state_changes: {},
    verification: { version: 1, textSha256: createHash("sha256").update(content).digest("hex"), checks: [{ status: "uncertain" }], reviews: [{ attempt: 0, result: { status: "verified" } }] } };
  assert.equal(snapshotNarrativeEvidence([row]).sources[0].authority, "verified_narration");
  assert.equal(snapshotNarrativeEvidence([{ ...row, content: "Договор касается района." }]).sources[0].authority, "legacy_narration");
  assert.equal(snapshotNarrativeEvidence([{ ...row, verification: { ...row.verification, checks: [{ status: "uncertain" }, { status: "uncertain" }] } }]).sources[0].authority, "legacy_narration");
  assert.equal(snapshotNarrativeEvidence([{ ...row, verification: { ...row.verification, checks: [{ status: "rejected" }] } }]).sources[0].authority, "legacy_narration");
});

test("snapshot preserves evidence text/hash and marks disputed or truncated narrator evidence", () => {
  const rows = [{ id: "a", turn_number: 46, role: "narrator", content: "Ты получил штаны", state_changes: { rejected: ["не получен"] } }];
  const snapshot = snapshotNarrativeEvidence(rows);
  assert.equal(snapshot.sources[0].authority, "disputed_narration");
  rows[0].content = "changed";
  assert.equal(snapshot.sources[0].text, "Ты получил штаны");
  assert.equal(snapshot.sources[0].sha256.length, 64);
  const huge = snapshotNarrativeEvidence([{ ...rows[0], content: "x".repeat(40000) }]);
  assert.equal(huge.truncated, true);
  assert.equal(huge.sources[0].truncated, true);
});

test("evidence queries bind action and IDs rather than interpolating raw input", () => {
  const query = buildNarrativeEvidenceQuery({ sessionId: "' OR true --", beforeTurn: 4, action: "'; DROP TABLE game_turns; --", sourceTurns: [1, 999, -1] });
  assert.ok(!query.text.includes("DROP TABLE"));
  assert.ok(query.values.includes("' OR true --"));
});

test("original evidence remains retrievable and bounded with 100, 1000 and 10000 historical turns", async t => {
  const pg = new PGlite();
  try {
    await pg.exec("CREATE TABLE game_turns(id text, session_id text, turn_number int, role text, content text, state_changes jsonb, context_meta jsonb)");
    await pg.exec(await readFile("drizzle/0009_narrative_evidence_search.sql", "utf8"));
    for (const count of [100, 1000, 10000]) {
      await pg.exec("TRUNCATE game_turns");
      await pg.query(`INSERT INTO game_turns(id, session_id, turn_number, role, content, state_changes, context_meta)
        SELECT 'a-' || n || '-' || role, 'a', n, role,
          CASE WHEN n = 10 AND role = 'narrator'
            THEN 'Мира заключила договор: вернуть амулет в обмен на владение вещью.'
            ELSE repeat('Путник осматривает дорогу и продолжает путь. ', 40) END,
          null, null
        FROM generate_series(1, $1::integer) n CROSS JOIN (VALUES ('player'), ('narrator')) roles(role)`, [count]);
      await pg.query(`INSERT INTO game_turns(id, session_id, turn_number, role, content, state_changes, context_meta) VALUES
        ('foreign', 'b', 10, 'narrator', 'Мира договор амулет район', null, null),
        ('future', 'a', $1, 'narrator', 'Мира договор амулет район', null, null)`, [count + 1]);
      for (const sourceTurns of [[], [10]]) {
        const query = buildNarrativeEvidenceQuery({ sessionId: "a", beforeTurn: count + 1,
          action: sourceTurns.length ? "продолжить путь" : "договор Миры об амулете", sourceTurns });
        const started = performance.now();
        const rows = (await pg.query(query.text, query.values)).rows;
        const snapshot = snapshotNarrativeEvidence(rows);
        t.diagnostic(`${count} turns, ${sourceTurns.length ? "source reference" : "lexical retrieval"}: ${(performance.now() - started).toFixed(1)} ms (local PGlite)`);
        assert.ok(rows.length <= 40);
        assert.ok(snapshot.sources.some(source => source.id === "a-10-narrator"));
        assert.ok(snapshot.sources.every(source => source.id !== "foreign" && source.id !== "future"));
        assert.ok(snapshot.sources.reduce((sum, source) => sum + source.text.length, 0) <= 32000);
        assert.equal(snapshot.completeHistory, false);
      }
    }
  } finally { await pg.close(); }
});
