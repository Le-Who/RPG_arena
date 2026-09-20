import { readFile } from "node:fs/promises";
import { verifyTypeSafeFacts } from "../src/lib/typesafe";
import { scoreTypeSafeEvaluations, type TypeSafeEvalOutcome } from "../src/lib/typesafe-eval";
import type { TypeSafeVerdict } from "../src/lib/typesafe-report";

type Scenario = {
  id: string;
  narration: string;
  playerAction: string;
  fact: string;
  evidence: string;
  expected: TypeSafeVerdict;
  category: string;
};

async function run() {
  const scenarios = JSON.parse(await readFile(new URL("../tests/fixtures/typesafe-scenarios.json", import.meta.url), "utf8")) as Scenario[];
  if (!process.argv.includes("--live")) {
    console.log(`DRY RUN: ${scenarios.length} размеченных сценариев готовы. Добавьте --live для реальных запросов TypeSafe.`);
    return;
  }
  const apiKey = process.env.TYPESAFE_API_KEY?.trim() ?? "";
  if (!apiKey) throw new Error("Для --live задайте TYPESAFE_API_KEY. Без флага реальные запросы не выполняются.");
  const outcomes: TypeSafeEvalOutcome[] = [];
  const failures: { id: string; error: string }[] = [];
  for (const scenario of scenarios) {
    const report = await verifyTypeSafeFacts({
      enabled: true,
      apiKey,
      narration: scenario.narration,
      playerAction: scenario.playerAction,
      facts: [{ type: "world", entityKey: scenario.id, title: scenario.id, content: scenario.fact, evidence: scenario.evidence, importance: 50, confidence: 0.8 }],
    });
    const actual = report.status === "ok" ? report.evaluations[0].choice : null;
    outcomes.push({ expected: scenario.expected, actual, latencyMs: report.latencyMs, inputTokens: report.usage?.inputTokens ?? 0, outputTokens: report.usage?.outputTokens ?? 0 });
    if (actual === null) failures.push({ id: scenario.id, error: report.error ?? report.status });
    console.log(`${scenario.id}: ${scenario.expected} -> ${actual ?? "ERROR"} (${report.latencyMs} ms)`);
  }
  const score = scoreTypeSafeEvaluations(outcomes);
  console.log(JSON.stringify({ ...score, failures }, null, 2));
}

run().catch((error) => { console.error(error instanceof Error ? error.message : "TypeSafe eval failed"); process.exitCode = 1; });
