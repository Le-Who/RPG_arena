import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { callGeminiWithRotation } from "../src/lib/gemini-transport";
import { narrativeReviewRequest } from "../src/lib/narrative-review-request";
import { matchesNarrativeCitation as cited, parseNarrativeReview } from "../src/lib/narrative-review";
import type { NarrativeCheckSelection, NarrativeVerdict } from "../src/lib/narrative-policy";
import { heldoutScenarios } from "./narrative-heldout-fixtures";
import { selectionFor } from "./narrative-evaluation-fixtures";

// Research only. No game gate, provider threshold, or campaign state is changed.
async function run() {
  const replayIndex = process.argv.indexOf("--replay");
  if (!process.argv.includes("--live") && replayIndex < 0) { console.log("Research-only review; use --live or --replay <saved synthetic report>."); return; }
  const heldout = process.argv.includes("--heldout");
  const fixtures = heldout ? heldoutScenarios.filter(s => ["h05_amended_deadline", "h09_failed_attempt", "h16_waived_condition", "h18_promise_completed", "h26_request_as_acceptance"].includes(s.id))
    .map(s => ({ syntheticOnly: true, id: s.id, expected: s.expected, state: s.state, selection: selectionFor(s) }))
    : await Promise.all(["agreement-create", "agreement-amend", "agreement-reject", "independent-false", "independent-true"].map(async id => {
      const text = await readFile(`output/narrative-evaluation/serialized/${id}.json`, "utf8");
      return JSON.parse(text) as { syntheticOnly: boolean; id: string; expected: NarrativeVerdict; state: Record<string, unknown>; selection: NarrativeCheckSelection };
    }));
  if (fixtures.length !== 5) throw new Error("incomplete_fixture_set");
  if (replayIndex >= 0) {
    const report = JSON.parse(await readFile(process.argv[replayIndex + 1], "utf8"));
    if (report.syntheticOnly !== true || report.researchOnly !== true || !Array.isArray(report.rows)) throw new Error("invalid_report");
    for (const row of report.rows) {
      const fixture = fixtures.find(f => f.id === row.id);
      if (!fixture || createHash("sha256").update(JSON.stringify(fixture)).digest("hex") !== row.fixtureHash) throw new Error("fixture_changed");
      const result = parseNarrativeReview(JSON.stringify({ answers: row.answers }), Object.keys(fixture.selection.questions), fixture.state);
      console.log(JSON.stringify({ id: row.id, expected: fixture.expected, originalStatus: row.status, replayStatus: result?.status ?? "invalid_evidence",
        normalized: result?.answers.filter(a => a.reportedVerdict) }));
    }
    return;
  }
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("missing_key");
  const rows = [];
  for (const fixture of fixtures) {
    const { id } = fixture;
    const text = JSON.stringify(fixture);
    if (fixture.syntheticOnly !== true) throw new Error("invalid_fixture");
    const reviewRequest = narrativeReviewRequest(fixture.selection);
    const started = performance.now();
    const response = await callGeminiWithRotation({ ...reviewRequest, keys: [apiKey], models: ["gemini-3.5-flash-lite"], temperature: 0, timeoutMs: 20000, maxTokens: 3500,
      user: JSON.stringify(fixture.state),
    });
    const review = parseNarrativeReview(response.text, Object.keys(fixture.selection.questions), fixture.state);
    const answers = review?.answers;
    const status = review?.status ?? "invalid_evidence";
    const row = { id, expected: fixture.expected, status, latencyMs: Math.round(performance.now() - started), fixtureHash: createHash("sha256").update(text).digest("hex"), answers };
    rows.push(row);
    console.log(JSON.stringify({ id, expected: row.expected, status, latencyMs: row.latencyMs,
      unresolved: answers?.filter(a => a.verdict !== "consistent" || !a.evidence.every(e => cited(fixture.state, e.path, e.quote))) }));
    if (rows.length < fixtures.length) await new Promise(resolve => setTimeout(resolve, 4100));
  }
  const output = `output/narrative-evaluation/adjudication-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(output, JSON.stringify({ syntheticOnly: true, researchOnly: true, heldout, model: "gemini-3.5-flash-lite", rows }, null, 2));
  console.log(JSON.stringify({ output, calls: rows.length }));
}
run().catch(() => { console.error("Synthetic adjudication failed; provider response and credentials suppressed."); process.exitCode = 1; });
