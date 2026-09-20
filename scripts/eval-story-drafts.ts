import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateStoryDraftPatch, validateStoryDraft, type StoryDraft, type StoryDraftPatch } from "../src/lib/story-draft";

type Fixture = { id: string; description: string; draft: StoryDraft };
type EvalResult = {
  id: string;
  description: string;
  passed: boolean;
  issues: string[];
  modelUsed?: string;
  latencyMs: number;
  patch?: StoryDraftPatch;
  error?: string;
};

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
}

const baseUrl = (argument("base-url") ?? process.env.STORY_EVAL_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const outputPath = argument("out");
const fixturePath = resolve("tests/fixtures/story-draft-scenarios.json");
const fixtures = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture[];

if (fixtures.length !== 24) throw new Error(`Ожидалось 24 сценария, найдено ${fixtures.length}.`);

console.log(`Реальная оценка автозаполнения: ${fixtures.length} сценария через ${baseUrl}. Mock-ответы не используются.`);
const results: EvalResult[] = [];

for (const fixture of fixtures) {
  validateStoryDraft(fixture.draft);
  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl}/api/story-drafts/autofill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft: fixture.draft }),
    });
    const payload = await response.json() as { patch?: StoryDraftPatch; modelUsed?: string; message?: string; error?: string };
    if (!response.ok || !payload.patch) throw new Error(payload.message ?? payload.error ?? `HTTP ${response.status}`);
    if (payload.modelUsed !== "gemini-3.5-flash-lite") throw new Error(`Unexpected model: ${payload.modelUsed}`);
    const assessment = evaluateStoryDraftPatch(fixture.draft, payload.patch);
    const result: EvalResult = { id: fixture.id, description: fixture.description, ...assessment, modelUsed: payload.modelUsed, latencyMs: Date.now() - started, patch: payload.patch };
    results.push(result);
    console.log(`${assessment.passed ? "PASS" : "FAIL"} ${fixture.id} · ${result.latencyMs} ms · ${payload.modelUsed}${assessment.issues.length ? ` · ${assessment.issues.join("; ")}` : ""}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ id: fixture.id, description: fixture.description, passed: false, issues: [message], latencyMs: Date.now() - started, error: message });
    console.error(`ERROR ${fixture.id} · ${message}`);
  }
}

const passed = results.filter((result) => result.passed).length;
const report = { kind: "real-provider-evaluation", coherenceReview: "pending-human-review", rubric: "Review every returned draft for genre, factual constraints, world/hero coherence and lack of imposed tone/profession. Structural PASS is not a quality verdict.", generatedAt: new Date().toISOString(), baseUrl, total: results.length, passed, failed: results.length - passed, results };
if (outputPath) writeFileSync(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Итог: ${passed}/${results.length} сценариев прошли контрактные проверки.${outputPath ? ` Отчёт: ${resolve(outputPath)}` : ""}`);
if (passed !== results.length) process.exitCode = 1;
