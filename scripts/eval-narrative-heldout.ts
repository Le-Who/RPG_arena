import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { heldoutScenarios } from "./narrative-heldout-fixtures";
import { scoreNarrativeEvaluation, selectionFor } from "./narrative-evaluation-fixtures";
import { verifyNarrative, type NarrativeVerification } from "../src/lib/narrative-verifier";

// Frozen before held-out calls: semantic unanimity is a research comparator, NOT runtime approval.
// Development data showed every valid answer chose consistent and every invalid draft had a dissent.
function unanimity(result: Pick<NarrativeVerification, "status" | "answers">) {
  if (["unavailable", "skipped", "rejected"].includes(result.status)) return result.status;
  const answers = Object.values(result.answers);
  return answers.length > 0 && answers.every(a => a.choice === "consistent") ? "verified" as const : "uncertain" as const;
}
async function run() {
  const fixtureHash = createHash("sha256").update(JSON.stringify(heldoutScenarios)).digest("hex");
  const developmentText = await readFile("output/narrative-evaluation/run-2026-09-20T17-14-12-628Z.json", "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  const development = developmentText ? JSON.parse(developmentText) : null;
  const developmentScores = development ? { strict: scoreNarrativeEvaluation(development.rows), unanimity: scoreNarrativeEvaluation(development.rows.map((r: NarrativeVerification) => ({ ...r, status: unanimity(r) }))) } : null;
  if (!process.argv.includes("--live")) { console.log(JSON.stringify({ mode: "dry", scenarios: heldoutScenarios.length, fixtureHash, developmentScores }, null, 2)); return; }
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENROUTER_API_KEY missing");
  const rows = [];
  let calls = 0;
  let stopReason: string | null = null;
  for (const scenario of heldoutScenarios) {
    const selection = selectionFor(scenario);
    let httpStatus: number | null = null;
    const observedFetch: typeof fetch = async (url, init) => { calls++; const res = await fetch(url, init); httpStatus = res.status; return res; };
    const result = await verifyNarrative({ selection, state: scenario.state, apiKey, provider: "openrouter", timeoutMs: 5000, fetchImpl: observedFetch });
    const row = { id: scenario.id, expected: scenario.expected, ...result, candidateStatus: unanimity(result), httpStatus };
    rows.push(row);
    console.log(JSON.stringify({ id: row.id, expected: row.expected, status: row.status, candidateStatus: row.candidateStatus, httpStatus }));
    if (httpStatus !== null && [401, 402, 403, 429].includes(httpStatus)) { stopReason = `http_${httpStatus}`; break; }
    if (result.reason === "invalid_response") { stopReason = "invalid_response"; break; }
    if (calls >= 30) { stopReason = "call_limit"; break; }
    if (rows.length < heldoutScenarios.length) await new Promise(resolve => setTimeout(resolve, 1200));
  }
  const report = { date: new Date().toISOString(), syntheticOnly: true, fixtureHash, calls, stopReason, candidate: "all selected choices consistent; strict rejection preserved; unavailable/skipped preserved; no numeric threshold fitting", developmentScores, strict: scoreNarrativeEvaluation(rows), unanimity: scoreNarrativeEvaluation(rows.map(r => ({ ...r, status: r.candidateStatus }))), rows };
  await mkdir("output/narrative-evaluation", { recursive: true });
  const output = `output/narrative-evaluation/heldout-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(output, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({ output, calls, strict: report.strict, unanimity: report.unanimity }));
}
run().catch(error => { console.error(error instanceof Error ? error.message : "evaluation_failed"); process.exitCode = 1; });
