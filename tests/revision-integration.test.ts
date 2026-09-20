import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("reading preferences turn malformed input into safe defaults", async () => {
  const { DEFAULT_READING, normalizeReading } = await import("../src/lib/reading-preferences");

  assert.deepEqual(normalizeReading(null), DEFAULT_READING);
  assert.deepEqual(normalizeReading({ theme: "unknown", motion: 42 }), DEFAULT_READING);
  assert.deepEqual(normalizeReading({ theme: "sepia" }), {
    textScale: "normal",
    measure: "normal",
    theme: "sepia",
    motion: "full",
  });
});

test("world map graph removes duplicate, self and dangling routes", async () => {
  const { mapEdges, projector } = await import("../src/lib/world-graph");
  const nodes = [
    { id: "a", name: "Порт", x: 2, y: 4, connectedTo: ["a", "b", "b", "missing"] },
    { id: "b", name: "Башня", x: 8, y: 10, connectedTo: ["a"] },
  ];

  assert.deepEqual(mapEdges(nodes).map(({ a, b }) => [a.id, b.id]), [["a", "b"]]);
  const place = projector(nodes, 15);
  for (const node of nodes) {
    const point = place(node.x, node.y);
    assert.ok(point.left > 20 && point.left < 80);
    assert.ok(point.top > 20 && point.top < 80);
  }
});

test("streamed JSON limit rejects a body larger than the declared budget", async () => {
  const { HttpError, readJsonObject } = await import("../src/lib/http");
  const request = new Request("https://example.test/api", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": "1" },
    body: JSON.stringify({ action: "я".repeat(100) }),
  });

  await assert.rejects(readJsonObject(request, 100), (error: unknown) => {
    return error instanceof HttpError && error.status === 413;
  });
});

test("v2.5 reading migration is additive and preserves legacy columns", () => {
  const migration = readFileSync("drizzle/0003_reading_preferences.sql", "utf8");
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "reading" jsonb NOT NULL/i);
  assert.doesNotMatch(migration, /\b(?:DROP|DELETE|UPDATE|TRUNCATE)\b/i);

  const base = readFileSync("drizzle/0000_chronicle_engine_v2.sql", "utf8");
  for (const column of ["primary_model", "fallback_chain", "access_count", "last_accessed_at"]) {
    assert.match(base, new RegExp(`"${column}"`, "i"), `${column} remains available for upgrades`);
  }

  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { tag: string }[] };
  assert.deepEqual(journal.entries.map((entry) => entry.tag), [
    "0000_chronicle_engine_v2",
    "0001_workspace_reliability",
    "0002_story_branches_and_jobs",
    "0003_reading_preferences",
    "0004_typesafe_pilot",
  ]);
});
