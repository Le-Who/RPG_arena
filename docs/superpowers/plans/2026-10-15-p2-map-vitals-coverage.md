# P2 map and WebVitals coverage implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Close the named local world-graph, map keyboard and WebVitals privacy/lifecycle gaps.

**Architecture:** Literal pure graph contracts and actual WorldMap/Dialog in isolated Chromium first; then actual WebVitalsReporter with controlled browser metric/observer inputs and captured HTTP requests. Retain original GREEN and genuine behavioral RED separately. Fix only reproduced defects, preserve earlier changes.

**Tech Stack:** Node24/node:test/tsx, esbuild, Playwright Chromium, installed Next16.3.8.

**Spec:** [Coverage matrix domain24](../../testing/coverage-matrix-2026-10-09.md), [coding standards](../../../CODING_STANDARDS.md).

## Global constraints and review focus

- Existing attached worktree; 574 main preimages and prior1004 LCOV archived. No commit/push, real DB/provider or env files. Subagents gpt-6.1-sol; medium for bounded graph math, high for browser/lifecycle/review.
- Historical migrations/dependencies remain unchanged. Production fixes need retained behavioral RED; do not manufacture failures for already correct behavior.
- Projection should preserve ordinary finite geometry; malformed coordinates must not poison other visible pins or SVG lines. Explicit single/empty/degenerate cases and caller purity.
- Keyboard tests use actual WorldMap and Dialog, literal callback target, focus trap/return, Escape/selection, discovery filtering and desktop/mobile layouts. Avoid fixture-reimplemented navigation logic.
- Privacy controls must prevent sends; queued data must not leak after opt-out. Pagehide/hidden/unmount flush and remount dedupe must be observable through exact requests, not source matches.
- Browser tests are separate evidence from ordinary runtime registrations and LCOV; simulated vitals are not field-performance measurements or full Next deployment.

## Task 1: Current graph contracts

**Files:** new `tests/world-graph-boundaries-p2.test.ts`, `src/lib/world-graph.ts` only for reproduced defects.

- [x] Add literal danger thresholds24/25/49/50, finite projection geometry for single/empty/degenerate/small/large sets, invalid-coordinate resilience and purity; run original suite and retain evidence.
- [x] Apply minimal demonstrated fix, rerun new and adjacent graph tests, release source and write `output/p2-map-vitals-coverage/graph-report.md`.

Task1 evidence: original 36 tests (22 new, 14 adjacent), 27 pass and nine behavioral assertion failures; minimal per-axis finite bounds and centered invalid coordinates produce 36/36 GREEN. Raw original/GREEN logs, exit JSON and source `.ts.preimage` are retained under `output/p2-map-vitals-coverage/`. Source/test ownership released for coordinator review; full-suite, docs and build verification belong to Task4.

## Task 2: Actual map keyboard navigation

**Files:** new `scripts/world-map-keyboard-p2-browser.ts`; `src/components/world-map.tsx`/`dialog.tsx` only for reproduced defects. Graph source belongs to Task1.

- [x] Bundle production WorldMap/Dialog with literal discovered/hidden/large fixtures; use keyboard to open dialog, traverse/trap, activate location, close with Escape/button, verify exact callback and focus return.
- [x] Verify read-only/empty/single map behavior, large-map scroll/reachable pins, desktop/mobile overflow and no page errors; retain original run, fix demonstrated failures and report/release.

## Task 3: Actual WebVitals privacy and lifecycle

**Files:** new `scripts/web-vitals-lifecycle-p2-browser.ts`; `src/components/web-vitals.tsx` only for reproduced defects. Add ordinary tests only if a meaningful production seam needs them.

- [x] After map implementation, mount actual reporter in production-mode bundle. Explicit metric/observer inputs, DNT/GPC combinations, exact safe route/device payloads and no raw path/ID leakage.
- [x] Exercise pagehide/visibility/unmount, timer/batch boundaries and repeated mount cleanup/dedupe. Test opt-out before queued flush and invalid values before dedupe admission. Retain RED/GREEN and report/release.

Task3 evidence: corrected unchanged-reporter baseline15/25 GREEN and ten genuine behavioral assertion failures across queued opt-out drains, buffered measure replay and invalid vital/resource dedupe admission. Minimal flush privacy recheck, WeakSet entry identity and successful-enqueue admission fixes produce25/25 Chromium GREEN. Native PerformanceObserver replay and an actual trusted pagehide navigation with loopback keepalive HTTP receipt pass; distinct equal-timed measures remain separate samples. The Next callback registration and most observer inputs are explicit fixture boundaries; native navigation transport metadata uses fixture-only sessionStorage and is not production reporter storage. Earlier harness clock/unload instrumentation failures are retained as separately named fixture drafts, not product RED. Source preimage, raw logs/exit JSON, exact request bodies, screenshots and scope limitations are recorded under `output/p2-map-vitals-coverage/` and `output/playwright/web-vitals-lifecycle-p2/`; source/script ownership released for coordinator review. Chromium proves this browser's entry identity behavior, not cross-browser field measurements or a full Next deployment.

## Task 4: Independent review and delivery

- [x] Fresh independent task and combined review with focused reruns; resolve findings.
- [x] Freeze src/tests/scripts/config, run full coverage, typecheck, lint, docs and default isolated Turbopack build using safe allowlisted environment.
- [x] Refresh inventory/matrix/roadmap/report, preserve prior1004 raw LCOV and earlier history; validate paths/hashes and distinguish browser scope.
- [x] Verify all574 main preimages, deliver only stage deltas, prove frozen byte equality and run proportional main focused/type/lint/docs checks.

Ruling: user explicitly authorized continued implementation with subagents. Proceed without an extra approval pause; reuse existing isolation and owned physical build dependencies after hash validation.



