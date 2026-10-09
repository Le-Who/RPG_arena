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

class EvalFailure extends Error {}
function positiveInteger(name: string, fallback: number, maximum: number) {
  const raw = argument(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new EvalFailure(`STORY_EVAL_INVALID_${name.toUpperCase().replaceAll("-", "_")}`);
  return value;
}

async function run() {
  const outputPath = argument("out");
  const fixtures = JSON.parse(readFileSync(resolve("tests/fixtures/story-draft-scenarios.json"), "utf8")) as Fixture[];
  if (fixtures.length !== 24) throw new EvalFailure("STORY_EVAL_INVALID_FIXTURES");
  for (const fixture of fixtures) validateStoryDraft(fixture.draft);
  if (!process.argv.includes("--live")) {
    console.log(`DRY RUN: ${fixtures.length} сценария готовы. Добавьте --live для запросов к выбранному провайдеру через приложение.`);
    return;
  }
  const cookie = (argument("cookie") ?? process.env.STORY_EVAL_COOKIE ?? "").trim();
  if (!cookie || /[\r\n]/.test(cookie)) throw new EvalFailure("Для --live задайте STORY_EVAL_COOKIE или --cookie с авторизованной сессией приложения.");
  const maxCalls = positiveInteger("max-calls", 24, 24);
  if (fixtures.length > maxCalls) throw new EvalFailure("STORY_EVAL_CALL_BUDGET: число сценариев превышает --max-calls.");
  const timeoutMs = positiveInteger("timeout-ms", 45_000, 45_000);
  const expectedModel = argument("expected-model");
  let parsedUrl: URL;
  try { parsedUrl = new URL(argument("base-url") ?? process.env.STORY_EVAL_BASE_URL ?? "http://localhost:3000"); }
  catch { throw new EvalFailure("STORY_EVAL_INVALID_BASE_URL"); }
  if (!["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) throw new EvalFailure("STORY_EVAL_INVALID_BASE_URL");
  const baseUrl = parsedUrl.href.replace(/\/$/, "");
  console.log(`Оценка автозаполнения: ${fixtures.length} сценария через ${baseUrl}. Структурный PASS требует отдельной проверки связности человеком.`);
  const results: EvalResult[] = [];

  for (const fixture of fixtures) {
    const started = Date.now();
    try {
      const response = await fetch(`${baseUrl}/api/story-drafts/autofill`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: process.env.CHRONICLE_PUBLIC_ORIGIN || parsedUrl.origin, Cookie: cookie },
        redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ draft: fixture.draft }),
      });
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new EvalFailure(`STORY_EVAL_HTTP_${response.status}`); }
      const payload = await response.json() as { patch?: StoryDraftPatch; modelUsed?: string };
      if (!payload || !payload.patch || typeof payload.patch !== "object" || Array.isArray(payload.patch) || !Object.values(payload.patch).every(value => typeof value === "string")) throw new EvalFailure("STORY_EVAL_INVALID_RESPONSE");
      if (typeof payload.modelUsed !== "string" || !payload.modelUsed.trim() || payload.modelUsed.length > 200 || /[\r\n]/.test(payload.modelUsed)) throw new EvalFailure("STORY_EVAL_INVALID_MODEL");
      if (expectedModel !== undefined && payload.modelUsed !== expectedModel) throw new EvalFailure("STORY_EVAL_UNEXPECTED_MODEL");
      const assessment = evaluateStoryDraftPatch(fixture.draft, payload.patch);
      const result: EvalResult = { id: fixture.id, description: fixture.description, ...assessment, modelUsed: payload.modelUsed, latencyMs: Date.now() - started, patch: payload.patch };
      results.push(result);
      console.log(`${assessment.passed ? "PASS" : "FAIL"} ${fixture.id} · ${result.latencyMs} ms · ${payload.modelUsed}${assessment.issues.length ? ` · ${assessment.issues.join("; ")}` : ""}`);
    } catch (error) {
      const message = error instanceof EvalFailure ? error.message : error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "STORY_EVAL_TIMEOUT" : "STORY_EVAL_REQUEST_FAILED";
      results.push({ id: fixture.id, description: fixture.description, passed: false, issues: [message], latencyMs: Date.now() - started, error: message });
      console.error(`ERROR ${fixture.id} · ${message}`);
    }
  }

  const passed = results.filter((result) => result.passed).length;
  const report = { kind: "real-provider-evaluation", coherenceReview: "pending-human-review", rubric: "Review every returned draft for genre, factual constraints, world/hero coherence and lack of imposed tone/profession. Structural PASS is not a quality verdict.", generatedAt: new Date().toISOString(), baseUrl, total: results.length, passed, failed: results.length - passed, results };
  if (outputPath) writeFileSync(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Итог: ${passed}/${results.length} сценариев прошли контрактные проверки.${outputPath ? ` Отчёт: ${resolve(outputPath)}` : ""}`);
  if (passed !== results.length) process.exitCode = 1;
}

run().catch(error => { console.error(error instanceof EvalFailure ? error.message : "STORY_EVAL_FAILED"); process.exitCode = 1; });
