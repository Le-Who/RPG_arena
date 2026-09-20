import { mkdir, writeFile } from "node:fs/promises";
import { verifyNarrative, NARRATIVE_PROVIDERS } from "../src/lib/narrative-verifier";
import { scenarios, scoreNarrativeEvaluation, selectionFor } from "./narrative-evaluation-fixtures";

async function run() {
  const live = process.argv.includes("--live");
  const limitArg = process.argv.find(a => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : scenarios.length;
  if (!Number.isInteger(limit) || limit < 1 || limit > 30) throw new Error("limit must be 1..30");
  const selected = scenarios.slice(0, limit);
  if (!live) { console.log(JSON.stringify({ mode: "dry", scenarios: selected.length, guarded: selected.filter(s => selectionFor(s).required).length, endpoint: NARRATIVE_PROVIDERS.openrouter.endpoint })); return; }
  const apiKey = process.env.OPENROUTER_API_KEY?.trim() ?? "";
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is missing");
  const rows = [];
  let calls = 0;
  let stopReason: string | null = null;
  for (const scenario of selected) {
    const selection = selectionFor(scenario);
    let httpStatus: number | null = null;
    let shape: Record<string, unknown> | null = null;
    const observedFetch: typeof fetch = async (url, init) => {
      calls++;
      const res = await fetch(url, init);
      httpStatus = res.status;
      if (res.ok) {
        // Inspect a clone only for protocol compatibility. Never persist body, state, prompts or headers.
        try {
          const raw = await res.clone().json() as Record<string, unknown>;
          const answers = raw.answers && typeof raw.answers === "object" ? raw.answers as Record<string, Record<string, unknown>> : {};
          shape = { model: typeof raw.model === "string" && /^(typesafe\/)?jev[-.\d]+$/.test(raw.model) ? raw.model : "unrecognized", topLevelKeys: Object.keys(raw).filter(k => ["id", "model", "answers", "usage", "provider", "created"].includes(k)), answers: Object.fromEntries(Object.entries(answers).filter(([id]) => id in selection.questions).map(([id, answer]) => [id, { keys: Object.keys(answer).filter(k => ["type", "choice", "confidence", "probabilities"].includes(k)), confidenceType: typeof answer.confidence, probabilityType: typeof answer.probabilities, probabilitySum: answer.probabilities && typeof answer.probabilities === "object" ? Object.values(answer.probabilities).filter((p): p is number => typeof p === "number").reduce((a, b) => a + b, 0) : null }])) };
        } catch { shape = { parseableJson: false }; }
      }
      return res;
    };
    const result = await verifyNarrative({ selection, state: scenario.state, apiKey, provider: "openrouter", timeoutMs: 5000, fetchImpl: observedFetch });
    const row = { id: scenario.id, expected: scenario.expected, status: result.status, latencyMs: result.latencyMs, reason: result.reason, httpStatus, model: result.model, answers: result.answers, usage: result.usage, selectionReasons: selection.reasons, responseShape: shape };
    rows.push(row);
    console.log(JSON.stringify({ id: row.id, expected: row.expected, status: row.status, latencyMs: row.latencyMs, reason: row.reason, httpStatus }));
    if (httpStatus !== null && [401, 402, 403, 429].includes(httpStatus)) { stopReason = `http_${httpStatus}`; break; }
    if (result.reason === "invalid_response") { stopReason = "protocol_incompatibility"; break; }
    if (rows.length < selected.length) await new Promise(resolve => setTimeout(resolve, 1200));
  }
  const report = { date: new Date().toISOString(), syntheticOnly: true, endpoint: NARRATIVE_PROVIDERS.openrouter.endpoint, requestedModel: NARRATIVE_PROVIDERS.openrouter.model, deadlineMs: 5000, pacingMs: 1200, retryCount: 0, calls, stopReason, score: scoreNarrativeEvaluation(rows), rows };
  await mkdir("output/narrative-evaluation", { recursive: true });
  const output = `output/narrative-evaluation/run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(output, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({ output, calls, stopReason, score: report.score }));
}
run().catch(() => { console.error("Narrative evaluation failed; credentials and raw provider errors suppressed."); process.exitCode = 1; });
