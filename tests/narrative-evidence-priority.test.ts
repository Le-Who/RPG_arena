import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { buildNarrativeEvidenceQuery, snapshotNarrativeEvidence } from "../src/lib/narrative-evidence";

test("retrieved references reserve the existing slots before global references and reject invalid turns", () => {
  const query = buildNarrativeEvidenceQuery({ sessionId: "a", beforeTurn: 100, action: "Продолжить",
    sourceTurns: Array.from({ length: 60 }, (_, i) => i + 1),
    prioritySourceTurns: [80, 81, 80, 0, -1, 100, 101, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1],
  });
  assert.deepEqual(query.values[3], [80, 81, ...Array.from({ length: 14 }, (_, i) => i + 1)]);
  assert.deepEqual(query.values[4], [80, 81]);
  assert.deepEqual(buildNarrativeEvidenceQuery({ sessionId: "a", beforeTurn: 3, action: "", sourceTurns: [1, 2] }).values.slice(3), [[1, 2], []]);
});

test("retrieval priority survives SQL ordering and text clipping without admitting foreign or future text", async () => {
  const pg = new PGlite();
  try {
    await pg.exec("CREATE TABLE game_turns(id text, session_id text, turn_number int, role text, content text, state_changes jsonb, context_meta jsonb)");
    await pg.exec(await readFile("drizzle/0009_narrative_evidence_search.sql", "utf8"));
    await pg.query(`INSERT INTO game_turns SELECT 'a-'||n||role, 'a', n, role, repeat('Фон. ', 1200), null, null
      FROM generate_series(1,18) n CROSS JOIN (VALUES ('player'),('narrator')) r(role)`);
    const original = "А не утверждал, что резонанса не было. Б услышал и отверг сообщение.";
    for (const [id, session, turn, role, text] of [
      ["target", "a", 80, "narrator", original], ["intent", "a", 80, "player", "Пытаюсь убедить Б."],
      ["later", "a", 81, "narrator", "Причина всё ещё неизвестна."],
      ["foreign", "b", 80, "narrator", "Иной канон"], ["future", "a", 100, "narrator", "Будущий канон"],
    ]) await pg.query("INSERT INTO game_turns VALUES ($1,$2,$3,$4,$5,null,null)", [id, session, turn, role, text]);
    const sourceTurns = [...Array.from({ length: 18 }, (_, i) => i + 1), 80, 81];
    const query = buildNarrativeEvidenceQuery({ sessionId: "a", beforeTurn: 100, action: "Продолжить", sourceTurns, prioritySourceTurns: [80, 81] });
    const rows = (await pg.query(query.text, query.values)).rows;
    const snapshot = snapshotNarrativeEvidence(rows, sourceTurns);
    assert.deepEqual(snapshot.sources.slice(0, 3).map(s => s.id), ["target", "intent", "later"]);
    assert.equal(snapshot.sources[0].text, original);
    assert.equal(snapshot.sources[0].authority, "legacy_narration");
    assert.equal(snapshot.sources[1].authority, "intention");
    assert.ok(!snapshot.sources.some(s => ["foreign", "future"].includes(s.id)));
    assert.ok(rows.length <= 40);
    assert.ok(snapshot.sources.every(s => s.text.length <= 6000));
    assert.ok(snapshot.sources.reduce((sum, s) => sum + s.text.length, 0) <= 32000);
    assert.equal(snapshot.truncated, true); assert.equal(snapshot.completeHistory, false);
    // Without retrieval the previous chronological fallback ordering remains intact.
    const fallback = buildNarrativeEvidenceQuery({ sessionId: "a", beforeTurn: 100, action: "Продолжить", sourceTurns: [2, 1] });
    const fallbackRows = (await pg.query(fallback.text, fallback.values)).rows as { turn_number: number }[];
    assert.deepEqual(fallbackRows.slice(0, 4).map(r => r.turn_number), [1, 1, 2, 2]);
  } finally { await pg.close(); }
});

test("known missing source references mark incompleteness even when returned rows are short", () => {
  const row = { id: "a", turn_number: 3, role: "narrator", content: "А молчит.", state_changes: null };
  assert.equal(snapshotNarrativeEvidence([row], [3]).truncated, false);
  assert.equal(snapshotNarrativeEvidence([row], [3, 4]).truncated, true);
  assert.equal(snapshotNarrativeEvidence([], [3]).truncated, true);
  assert.equal(snapshotNarrativeEvidence([]).truncated, false);
  assert.equal(snapshotNarrativeEvidence([row], [3, 3]).truncated, false);
});
