import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { JEV_PROVIDERS } from "../src/lib/jev-tasks";
import { parsePrimitiveAnswers } from "./jev-evaluation";
import { researchRequests, decideDualNoul } from "./jev-research-fixtures";

async function run() {
  const requests = researchRequests();
  const hash = createHash("sha256").update(JSON.stringify(requests)).digest("hex");
  if (!process.argv.includes("--live")) { console.log(JSON.stringify({ syntheticOnly: true, version: "research-v1", hash, requests: requests.length, baseCases: requests.length / 2, families: new Set(requests.map(r => r.family)).size })); return; }
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error("missing_key");
  const rows = []; let calls = 0, stopReason: string | null = null;
  for (const request of requests) {
    const start = performance.now();
    try {
      calls++;
      const res = await fetch(JEV_PROVIDERS.openrouter.endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000), headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(request.body) });
      if (!res.ok) { await res.body?.cancel(); stopReason = `http_${res.status}`; break; }
      const parsed = parsePrimitiveAnswers(await res.json(), request.body.questions);
      const a = parsed.answers.verdict;
      const choiceDecision = a.confidence! >= .8 && a.probabilities![a.choice!] >= .9 ? a.choice! : "abstain";
      const dualDecision = decideDualNoul(parsed.answers.support.noul!, parsed.answers.contradiction.noul!);
      rows.push({ id: request.id, caseId: request.caseId, family: request.family, expected: request.expected, latencyMs: Math.round(performance.now() - start), choiceDecision, dualDecision, ...parsed });
      console.log(JSON.stringify({ id: request.id, expected: request.expected, choice: a.choice, choiceDecision, dualDecision }));
    } catch { stopReason = "transport_or_protocol_failure"; break; }
    if (rows.length < requests.length) await new Promise(r => setTimeout(r, 1200));
  }
  await mkdir("output/narrative-evaluation", { recursive: true });
  const output = `output/narrative-evaluation/research-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(output, JSON.stringify({ version: "research-v1", syntheticOnly: true, independentHumanLabels: false, hash, requests, calls, stopReason, deadlineMs: 5000, pacingMs: 1200, retries: 0, rows }, null, 2));
  console.log(JSON.stringify({ output, calls, stopReason }));
}
run().catch(() => { console.error("Research evaluation failed; raw errors suppressed."); process.exitCode = 1; });
