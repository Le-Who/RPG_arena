import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { verifyNarrative } from "../src/lib/narrative-verifier";
import type { NarrativeCheckSelection, NarrativeVerdict } from "../src/lib/narrative-policy";

// Generate these using CAPTURE_NARRATIVE_FIXTURES=1 and the PGlite integration test.
// This runner never connects to a campaign database or generates story text.
async function run() {
  const fixtures = await Promise.all(["agreement-create", "agreement-amend", "agreement-reject", "independent-false", "independent-true"].map(async id => {
    const text = await readFile(`output/narrative-evaluation/serialized/${id}.json`, "utf8");
    const fixture = JSON.parse(text) as { syntheticOnly: boolean; id: string; expected: NarrativeVerdict; state: Record<string, unknown>; selection: NarrativeCheckSelection };
    if (fixture.syntheticOnly !== true || fixture.id !== id) throw new Error("Invalid synthetic fixture");
    return { ...fixture, hash: createHash("sha256").update(text).digest("hex") };
  }));
  if (!process.argv.includes("--live")) { console.log(JSON.stringify(fixtures.map(f => ({ id: f.id, hash: f.hash })))); return; }
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENROUTER_API_KEY missing");
  const rows = [];
  for (const fixture of fixtures) {
    const selection = structuredClone(fixture.selection);
    if (process.argv.includes("--focused-instructions")) {
      for (const id of ["accepted_state", "outcome", "choices", "unlisted_events", "agreements"]) {
        const question = selection.questions[id];
        if (!question) continue;
        const marker = "При недостатке подтверждений — insufficient. ";
        const end = question.instructions.indexOf(marker);
        if (end >= 0) question.instructions = "Оцените только область указанного вопроса. Черновик описывает текущий ход. " + question.instructions.slice(end + marker.length);
      }
    }
    const result = await verifyNarrative({ state: fixture.state, selection, apiKey, provider: "openrouter", timeoutMs: 5000 });
    rows.push({ id: fixture.id, expected: fixture.expected, fixtureHash: fixture.hash, selection, ...result });
    const unresolved = Object.entries(result.answers).filter(([, a]) => a.choice !== "consistent" || a.confidence < .8 || a.probabilities.consistent < .9);
    console.log(JSON.stringify({ id: fixture.id, expected: fixture.expected, status: result.status, unresolved }));
    if (result.status === "unavailable") break;
  }
  const output = `output/narrative-evaluation/serialized-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(output, JSON.stringify({ syntheticOnly: true, scope: "actual performTurn input; fixed synthetic generation", rows }, null, 2));
  console.log(JSON.stringify({ output, calls: rows.length }));
}
run().catch(error => { console.error(error instanceof Error ? error.message : "evaluation_failed"); process.exitCode = 1; });
