import test from "node:test";
import assert from "node:assert/strict";
import { parseTurnQuery } from "../src/lib/command-query";
import { contrastRatio, gradeContrast, parseColor } from "../src/lib/contrast";
import { normalizeApiRoute, percentile, rateVital, summarizeApiTimings } from "../src/lib/perf-metrics";

const id = "0f8fad5b-d9cb-469f-a165-70867728950e";

test("UX-2b: palette turn queries accept ход/#/turn and reject everything else", () => {
  assert.equal(parseTurnQuery("ход 12"), 12);
  assert.equal(parseTurnQuery("  #7 "), 7);
  assert.equal(parseTurnQuery("Turn 3"), 3);
  assert.equal(parseTurnQuery("ход0"), null);
  assert.equal(parseTurnQuery("ход двенадцать"), null);
  assert.equal(parseTurnQuery("новая история"), null);
});

test("DS-2: WCAG contrast matches reference values and grades", () => {
  assert.equal(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }), 21);
  assert.ok(Math.abs(contrastRatio({ r: 119, g: 119, b: 119 }, { r: 255, g: 255, b: 255 }) - 4.47808945) < 0.00001);
  assert.equal(gradeContrast(4.48), "AA-large");
  assert.equal(gradeContrast(7.1), "AAA");
  assert.equal(gradeContrast(2), "fail");
  assert.equal(gradeContrast(contrastRatio({ r: 118.7, g: 118.7, b: 118.7 }, { r: 255, g: 255, b: 255 })), "AA-large", "rounding must not promote a ratio below 4.5 to AA");
  // Semi-transparent white over black is composited before measuring.
  assert.ok(contrastRatio({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0 }) < 21);
  assert.deepEqual(parseColor("#fff"), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor("rgba(10, 20, 30, 0.5)"), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(parseColor("rgb(10 20 30 / 50%)"), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.equal(parseColor("oklch(50% .1 200)"), null);
});

test("PERF-4: percentiles, route normalisation and Server-Timing summaries", () => {
  assert.equal(percentile([], 95), 0);
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 100], 95), 100);
  assert.equal(normalizeApiRoute(`/api/sessions/${id}/turns?before=3`), "/api/sessions/:id/turns");
  assert.equal(normalizeApiRoute("/play/abc"), null);
  const rows = summarizeApiTimings([
    { name: `http://localhost/api/sessions/${id}`, duration: 100, serverTiming: [{ name: "app", duration: 40 }], transferSize: 1000 },
    { name: `http://localhost/api/sessions/${id.replace("0f", "1f")}`, duration: 300, serverTiming: [{ name: "app", duration: 90 }], transferSize: 2000 },
    { name: "http://localhost/api/workspace", duration: 20 },
    { name: "http://localhost/_next/static/chunk.js", duration: 999 },
  ]);
  assert.deepEqual(rows.map(r => [r.route, r.count, r.p50, r.p95, r.serverP50, r.serverP95, r.bytes]), [
    ["/api/sessions/:id", 2, 100, 300, 40, 90, 3000],
    ["/api/workspace", 1, 20, 20, null, null, 0],
  ]);
  assert.equal(rateVital("lcp", 2000), "good");
  assert.equal(rateVital("cls", 0.2), "needs-improvement");
  assert.equal(rateVital("inp", 900), "poor");
  assert.equal(rateVital("ttfb", null), "unknown");
});
