import { readFile, writeFile } from "node:fs/promises";
import { guardNarrative } from "../src/lib/narrative-guard";
import { verifyNarrative } from "../src/lib/narrative-verifier";
import { narrativeReviewRequest } from "../src/lib/narrative-review-request";
import { callGeminiWithRotation } from "../src/lib/gemini-transport";
import { heldoutScenarios } from "./narrative-heldout-fixtures";

// Actual guard + both live verifiers, using performTurn's captured synthetic inputs.
// No campaign database or story generation; repair is disabled to isolate admission.
async function run() {
  if (!process.argv.includes("--live")) { console.log("Synthetic two-stage guard evaluation; add --live."); return; }
  const verifierKey = process.env.OPENROUTER_API_KEY?.trim(), generatorKey = process.env.GEMINI_API_KEY?.trim();
  if (!verifierKey || !generatorKey) throw new Error("missing_keys");
  const selectedCase = process.argv.find(a => a.startsWith("--case="))?.slice(7);
  const heldout = process.argv.includes("--heldout");
  const fixtures = heldout ? heldoutScenarios.map(s => ({ ...s, syntheticOnly: true }))
    : await Promise.all(["agreement-create", "agreement-amend", "agreement-reject", "independent-false", "independent-true"].map(async id => JSON.parse(await readFile(`output/narrative-evaluation/serialized/${id}.json`, "utf8"))));
  const selected = fixtures.filter(f => !selectedCase || f.id === selectedCase);
  if (!selected.length) throw new Error("invalid_case");
  const rows = [];
  for (const fixture of selected) {
    const id = fixture.id;
    if (fixture.syntheticOnly !== true) throw new Error("invalid_fixture");
    const state = fixture.state;
    const started = performance.now();
    let repairRequested = false;
    const reviewResponses: { text: string; latencyMs: number }[] = [];
    const attempts: { ok: boolean; latencyMs: number; error?: string }[] = [];
    const result = await guardNarrative({ action: state.player_action ?? fixture.action, narration: state.draft, choices: state.draft_choices,
      declaration: fixture.declaration ?? { mode: "event", referencesPast: true }, hasDice: fixture.hasDice ?? !!state.dice, hasStateChanges: fixture.hasStateChanges ?? true,
      hasProvisionalIndependentAdds: Array.isArray(state.provisional_independent_additions) && state.provisional_independent_additions.length > 0,
      rejected: state.rejected_changes, state, emittedPrefix: "", remainingMs: () => 30000 - (performance.now() - started),
      verify: (draft, selection) => verifyNarrative({ state: draft, selection, apiKey: verifierKey, provider: "openrouter", timeoutMs: 2500 }),
      review: async (draft, selection) => {
        const response = await callGeminiWithRotation({ ...narrativeReviewRequest(selection), keys: [generatorKey], models: ["gemini-3.5-flash-lite"],
          user: JSON.stringify(draft), temperature: 0, maxTokens: 3500, timeoutMs: 6000,
          onAttempt: info => { attempts.push({ ok: info.ok, latencyMs: info.latencyMs, ...(info.error ? { error: info.error.match(/TIMEOUT|HTTP \d{3}|INCOMPLETE_RESPONSE:[A-Z_]+/)?.[0] ?? "request_failed" } : {}) }); },
        });
        reviewResponses.push({ text: response.text, latencyMs: response.latencyMs });
        return { text: response.text, model: response.model, latencyMs: response.latencyMs };
      },
      repair: async () => { repairRequested = true; return null; },
    });
    const row = { id, expected: fixture.expected, ok: result.ok, reason: result.ok ? null : result.reason,
      latencyMs: Math.round(performance.now() - started), repairRequested, checks: result.checks, reviews: result.reviews, attempts, reviewResponses };
    rows.push(row);
    console.log(JSON.stringify({ id, expected: row.expected, ok: row.ok, reason: row.reason, latencyMs: row.latencyMs,
      checks: row.checks.map(c => c.status), reviews: row.reviews.map(r => r.result.status), repairRequested }));
    if (rows.length < selected.length) await new Promise(resolve => setTimeout(resolve, 4100));
  }
  const output = `output/narrative-evaluation/pipeline-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(output, JSON.stringify({ syntheticOnly: true, heldout, repairsDisabled: true, rows }, null, 2));
  console.log(JSON.stringify({ output, cases: rows.length }));
}
run().catch(() => { console.error("Synthetic pipeline evaluation failed; provider response and credentials suppressed."); process.exitCode = 1; });
