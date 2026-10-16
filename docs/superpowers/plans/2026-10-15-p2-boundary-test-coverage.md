# P2 batch, social and provider boundary coverage

> **For agentic workers:** Execute independent tasks with `dispatching-parallel-agents`; the coordinator owns shared review, verification, documentation and delivery.

**Goal:** Improve the next highest remaining deterministic boundaries in coverage matrix domains 4, 7 and 20, fixing only reproduced defects.

**Architecture:** Test real parsers/reducers and turn consumers with literal expected state, disposable migrated PGlite and synthetic transport where needed. Quote provenance and model verdict propagation remain distinct from semantic entailment. Cache/time/retry tests use controlled clocks and event barriers.

**Tech Stack:** npm, node:test, tsx, PGlite/pgvector, Drizzle, Next.js 16.3.8.

**Spec:** [Coverage matrix](../../testing/coverage-matrix-2026-10-09.md), domains 4/7/20; [coding standards](../../../CODING_STANDARDS.md); preceding [state coverage](../../p2-state-test-coverage-2026-10-15.md).

## Global constraints

- Reuse the attached `p2-state-test-coverage` worktree, seeded byte-exactly from the current main checkout. Preserve previous work, migrations, profiles/modes and Russian product copy.
- Subagents use gpt-6.1-sol: medium reasoning for isolated batch parsing/reducers; high for social persistence/verdict boundaries, async provider/caches and independent review.
- Safe preload and synthetic provider credentials only. No real DB, paid model, deployment, dependency changes, commit or push.
- Each worker owns its new test file and disjoint production modules. Ask the coordinator before shared turn.ts or schema changes. No source mutation controls while workers run.
- First run focused baselines, then new tests on original production. Separate genuine RED from fixture mistakes; investigate before minimal fixes.
- Check owned-file TypeScript diagnostics before release; no full suite per worker. Coordinator runs consolidated gates after freeze.

## Review focus

- Malformed JSON shapes must not escape parser/reducer boundaries or mutate inputs; supported sequential inventory operations preserve literal quantities and actual resource deltas.
- Duplicated/ambiguous references cannot select unrelated entities; known valid sibling proposals remain testable.
- A literal quote is source provenance, not proof about a named NPC or the current day; test current deterministic and configured verifier contracts without inventing semantic authority.
- Daily/once overnight windows, touching boundaries, overlap symmetry and current presence are explicit literal tables.
- SSE framing, ignored fields, Unicode/wire limits, cancellation, backoff and callback errors cannot silently produce duplicate or falsely successful work.
- Catalog pending deduplication, provider isolation, cloned results, exact TTL and failure recovery must be observed through real loaders/consumers.

### Task 1 — malformed and batch resolution

**Owned:** `tests/resolution-batch-p2.test.ts`; justified minimal fixes in `src/lib/resolution.ts` only.

- [x] Run resolution/inventory/resource baselines (54/54).
- [x] Add hand-authored malformed JSON envelope/nested collection cases through parseResolution and applyResolution, preserving valid siblings and immutable inputs under the supported contract.
- [x] Add realistic same-stack operation batches, alias/ambiguity controls and literal quantity/resource/applied evidence. Existing quantity default1 preserved; no new batch atomicity policy.
- [x] Reproduce five numeric coercion failures, apply minimal fix; new24/focused78 and owned diagnostics0, report/logs retained.

### Task 2 — social evidence and time windows

**Owned:** `tests/social-evidence-boundaries-p2.test.ts`; justified minimal fixes in `src/lib/world-social.ts` and `src/lib/world-agenda.ts` only.

- [x] Run existing social/agenda/owner baselines (28/28).
- [x] Add exact daily/once overnight presence and overlap boundary tables; fix two genuine day1 overlap/admission RED with one filter removal.
- [x] Exercise quotes about another NPC/future facts through actual turn verifier refusal. Provenance explicitly remains weaker than authored semantic verdict; no new entailment protocol.
- [x] Actual persisted refusal/acceptance controls; new47/focused75, diagnostics0 and limits recorded.

### Task 3 — streaming/retry and catalog caches

**Owned:** `tests/provider-boundaries-p2.test.ts`; justified minimal fixes in `src/lib/text-provider.ts` and `src/lib/text-model-catalog.ts` only.

- [x] Run existing text transport/catalog baselines (20/20).
- [x] Cover multiline/fragmented SSE, ignored wire fields/limits, event-based backoff cancellation and scoped callback failures.
- [x] Actual catalog loader/public GET pending/clone/provider/TTL/failure/recovery covered; catalog production unchanged.
- [x] Six genuine RED fixed, new15/focused75/types0. No upstream API contract change; no provider-doc contract migration required. Async void/stalled callbacks remain outside scope.

### Task 4 — review, consolidated verification and delivery

**Owned:** shared documentation, inventory and delivery, coordinator only.

- [x] Independent spec/code/test review PASS; fresh86/86 and440frozenfiles unchanged, no open findings.
- [x] Consolidated ordinary997/997, typecheck/lint/docs and isolated default Turbopack build passed on unchanged440 frozen files. Prior911 LCOV/history archived.
- [x] Update report, matrix, inventory and roadmap with actual counts and limitations.
- [x] Verify563 main preimages; transfer13 deltas; all440 frozen files byte-equal, fresh main86/type/lint pass. Keep logs under `output/p2-boundary-coverage/`.
