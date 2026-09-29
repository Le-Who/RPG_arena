import test from "node:test";
import assert from "node:assert/strict";
import { MAX_BATCH, buildTurnReport, buildVitalsReport, parseVitalBatch, percentile, rateSample, routeTemplate, summarize } from "../src/lib/performance-report";
import { estimatePromptTokens, measurePromptBudget, readPromptBudget } from "../src/lib/prompt-budget";
import { estimateTokens } from "../src/lib/gemini";

test("route templates never store campaign identifiers or unknown paths", () => {
  assert.equal(routeTemplate("/play/0f8fad5b-d9cb-469f-a165-70867728950e"), "/play/[id]");
  assert.equal(routeTemplate("/play/abc?x=1"), "/play/[id]");
  assert.equal(routeTemplate("/campaigns/"), "/campaigns");
  assert.equal(routeTemplate("/"), "/");
  assert.equal(routeTemplate("/secret/0f8fad5b"), "other");
  assert.equal(routeTemplate("https://evil.example/"), "other");
  assert.equal(routeTemplate(42), "other");
});

test("vital batches are bounded, re-rated on the server and reject invalid values", () => {
  const { samples, rejected } = parseVitalBatch({ samples: [
    { metric: "LCP", value: 1800, rating: "poor", route: "/play/0f8fad5b-d9cb-469f-a165-70867728950e", device: "mobile", navigationType: "navigate" },
    { metric: "CLS", value: 0.3, device: "tablet" },
    { metric: "API_WORKSPACE", value: 120.4567, route: "/" },
    { metric: "EVIL", value: 1 }, { metric: "INP", value: -1 }, { metric: "INP", value: Number.NaN }, { metric: "TTFB", value: 700_000 }, null,
  ] });
  assert.equal(samples.length, 3);
  assert.equal(rejected, 5);
  assert.deepEqual(samples[0], { metric: "LCP", route: "/play/[id]", value: 1800, rating: "good", device: "mobile", navigationType: "navigate" });
  assert.equal(samples[1].rating, "poor");
  assert.equal(samples[1].device, "unknown");
  assert.equal(samples[2].rating, "unknown");
  assert.equal(samples[2].value, 120.457);
  const many = parseVitalBatch({ samples: Array.from({ length: MAX_BATCH + 5 }, () => ({ metric: "FCP", value: 100 })) });
  assert.equal(many.samples.length, MAX_BATCH);
  assert.equal(many.rejected, 5);
  assert.deepEqual(parseVitalBatch({}).samples, []);
});

test("percentiles interpolate and summaries ignore non-finite values", () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.deepEqual(summarize([10, Number.NaN, 30, 20, 40]), { count: 4, p50: 25, p75: 32.5, p95: 38.5, max: 40 });
  assert.equal(rateSample("INP", 200), "good");
  assert.equal(rateSample("INP", 201), "needs-improvement");
  assert.equal(rateSample("INP", 501), "poor");
  assert.equal(rateSample("TURN_PAINT", 5), "unknown");
});

test("vitals report rates each metric at p75 and splits devices and routes", () => {
  const rows = [
    ...Array.from({ length: 8 }, (_, i) => ({ metric: "LCP", route: "/", device: "desktop", value: 1000 + i * 100 })),
    ...Array.from({ length: 4 }, () => ({ metric: "LCP", route: "/play/[id]", device: "mobile", value: "5000" })),
    { metric: "API_AUTH", route: "/", device: "desktop", value: 80 },
  ];
  const report = buildVitalsReport(rows);
  const lcp = report.vitals.find((vital) => vital.metric === "LCP")!;
  assert.equal(lcp.summary.count, 12);
  assert.equal(lcp.devices.mobile.count, 4);
  assert.equal(lcp.devices.desktop.p50, 1350);
  assert.equal(lcp.rating, "poor");
  assert.deepEqual(lcp.routes.map((route) => route.route), ["/", "/play/[id]"]);
  assert.equal(report.vitals.find((vital) => vital.metric === "INP")!.rating, "unknown");
  assert.equal(report.timings.find((timing) => timing.metric === "API_AUTH")!.summary.count, 1);
});

test("prompt budget measures sections without storing text and parses defensively", () => {
  const budget = measurePromptBudget({ system: "s".repeat(360), user: "u".repeat(36), schema: { type: "object" }, sections: { memory: "m".repeat(100), entities: ["ab", "cd"], life: "", recent: [{ a: 1 }] } });
  assert.equal(budget.systemChars, 360);
  assert.equal(budget.userChars, 36);
  assert.equal(budget.schemaChars, JSON.stringify({ type: "object" }).length);
  assert.equal(budget.sections.memory, 100);
  assert.equal(budget.sections.entities, 4);
  assert.equal(budget.sections.life, undefined);
  assert.equal(budget.estimatedTokens, 100 + 10 + estimatePromptTokens(budget.schemaChars));
  for (const text of ["", "a", "Привет, мир!", "x".repeat(1000)]) assert.equal(estimatePromptTokens(text.length), estimateTokens(text));
  assert.deepEqual(readPromptBudget(JSON.parse(JSON.stringify(budget))), budget);
  assert.equal(readPromptBudget({ ...budget, version: 2 }), null);
  assert.equal(readPromptBudget({ ...budget, systemChars: -1 }), null);
  assert.deepEqual(readPromptBudget({ ...budget, sections: { memory: 5, injected: 9 } })?.sections, { memory: 5 });
  assert.equal(JSON.stringify(budget).includes("mmm"), false);
});

test("turn report aggregates stored timings and prompt budgets per section", () => {
  const budget = (memory: number) => measurePromptBudget({ system: "s".repeat(1000), user: "u".repeat(200), sections: { memory: "m".repeat(memory), action: "go" } });
  const report = buildTurnReport([
    { timings: { serverMs: 1000, generationMs: 700, firstTextMs: 300, attempts: 1 }, budget: budget(300), model: "gemini-flash" },
    { timings: { serverMs: 3000, generationMs: 2500, attempts: 2 }, budget: budget(500), model: "gemini-flash" },
    { timings: null, budget: { version: 9 }, model: "offline-engine" },
  ]);
  assert.equal(report.turns, 3);
  assert.equal(report.timedTurns, 2);
  assert.equal(report.prompt.measuredTurns, 2);
  assert.equal(report.stages.find((stage) => stage.key === "serverMs")!.summary.p50, 2000);
  assert.equal(report.stages.find((stage) => stage.key === "firstTextMs")!.summary.count, 1);
  assert.equal(report.prompt.sections[0].key, "memory");
  assert.equal(report.prompt.sections[0].summary.p50, 400);
  assert.equal(report.prompt.sections[0].share, Math.round((400 / 1200) * 1000) / 10);
  assert.deepEqual(report.models, [{ model: "gemini-flash", count: 2 }, { model: "offline-engine", count: 1 }]);
});



test("metric allowlist rejects inherited object properties", () => {
  for (const metric of ["constructor", "toString", "__proto__"]) {
    assert.deepEqual(parseVitalBatch({ samples: [{ metric, value: 1 }] }), { samples: [], rejected: 1 });
  }
});

test("section percentages use each turn denominator instead of a ratio of unrelated medians", () => {
  const row = (system: number, memory: number) => ({ model: "test", timings: {}, budget: measurePromptBudget({ system: "s".repeat(system), user: "", sections: { memory: "m".repeat(memory) } }) });
  const report = buildTurnReport([row(100, 90), row(1000, 900), row(10000, 100)]);
  assert.equal(report.prompt.sections[0].share, 90);
  assert.equal(report.timedTurns, 0);
});
