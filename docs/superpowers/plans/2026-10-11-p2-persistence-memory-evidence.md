# P2 persistence, memory search and agreement evidence

> **For agentic workers:** Execute the independent tasks with `dispatching-parallel-agents`; the coordinator owns shared verification, review and delivery. Track completed steps below.

**Goal:** Cover the named P2 contracts in checkpoints/forks, actual memory retrieval and agreement evidence; fix reproduced defects and compatible scoped improvements with regression tests.

**Architecture:** Exercise existing production services and real SQL. Disposable PGlite supplies migrations, pgvector and deterministic database errors; mocks replace database transport or synthetic provider transport only. Tests use independent literal state, IDs, row counts and protocol outcomes. No new persistence or provider protocol is planned.

**Tech Stack:** npm, node:test, tsx, PGlite/pgvector, Drizzle, Next.js16.3.8.

**Spec:** [Coverage matrix](../../testing/coverage-matrix-2026-10-09.md), domains9/14/16, and the user's requested P2 scope. [Coding standards](../../../CODING_STANDARDS.md).

## Global constraints

- Start from committed `27ed12b` in the attached `p2-persistence-memory-evidence` worktree; preserve the prior worktree and main checkout.
- Use gpt-6.1-sol subagents, high reasoning for these SQL/persistence/evidence tasks and independent review.
- No real campaign database, inherited credentials, paid provider calls or deployment. Use the safe test environment preload.
- Preserve historical migrations, the ledger, public interfaces, campaign modes/profiles and Russian product copy.
- First run existing focused baseline tests; run new regressions against original production code before fixing a defect. Keep original RED and final GREEN evidence separate from harness corrections and mutation controls.
- Compatible improvements need a concrete benefit and tests; avoid unrelated refactoring or expanding architecture.
- No broad verification while a source mutation control is active. Restore exact source bytes before freezing and final gates.
- No commit/push in this implementation turn. Deliver verified deltas with main preimage and final SHA checks.

## Review focus

- Fork errors must roll back branch state, history, provenance, ledger and embedding work together.
- Deleted checkpoints must not delete existing branches or alter their immutable history.
- Cached query vectors must not cache database results; changed content with stale embedding hashes must not be returned.
- Ranking must use deterministic tie order, threshold before scoring and per-layer/final limits at the appropriate stages.
- Authentic historical quotes do not by themselves establish new terms; review and adapter checks must retain current version and source/campaign/turn scope.

### Task1 — checkpoints and forks

**Owned files:** new `tests/checkpoint-persistence-p2.test.ts`; minimal changes in `src/lib/checkpoints.ts`, `checkpoint-snapshot.ts` or `checkpoint-types.ts` only if justified.

- [x] Run existing focused persistence/branch baseline on disposable migrated SQL.
- [x] Cover twelve successful checkpoints and refusal of the thirteenth without writes; valid replay still succeeds at the cap.
- [x] Cover replay conflicts for changed title/expectedTurn and preserve checkpoint/fork data.
- [x] Delete the source checkpoint and assert an already-created branch retains its state, entities and history.
- [x] Inject SQL failure during fork materialization and assert complete rollback, including ledger and embedding work.
- [x] Reproduce/fix defects or record existing-correct coverage; verify restored controls and final focused tests.

### Task2 — memory search freshness and ranking

**Owned files:** new `tests/memory-search-freshness-p2.test.ts` or focused existing search tests; minimal changes in `src/lib/embeddings.ts`, `memory-search.ts` or `query-vectors.ts` only if justified.

- [x] Run existing actual-search and database ranking baseline.
- [x] Reuse the same cached query vector while changing database importance/turn/content; assert exact new results and no embedding provider call.
- [x] Exclude changed content until the stored embedding hash is current; retain model/dims/campaign boundaries.
- [x] Cover UUID tie order, similarity threshold and ranked layer/final limits using literal expected IDs.
- [x] Reproduce/fix defects or record existing-correct coverage; verify restored controls and final focused tests.

### Task3 — agreement evidence and review

**Owned files:** new `tests/narrative-evidence-p2.test.ts` or scoped existing evidence/review/agreement tests; minimal changes in the matching narrative modules only if justified.

- [x] Run existing evidence, agreement and review baseline.
- [x] Cover edited agreement terms, authentic older source text and current revision/version binding at the actual consumer boundary.
- [x] Cover snapshot mismatch and malformed adapter response refusal without treating unknown evidence as accepted canon.
- [x] Execute the actual limited evidence query against migrated SQL and assert future/foreign rows are excluded.
- [x] Reproduce/fix defects or record existing-correct coverage; verify restored controls and final focused tests.

### Task4 — independent review, verification and delivery

- [x] Review each domain's actual diff, original failures and test oracle independence with a separate gpt-6.1-sol reviewer.
- [x] Freeze source and run consolidated ordinary coverage, typecheck, lint, documentation checks and a production build when production changes warrant it.
- [x] Preserve the prior824 LCOV and refresh current inventory/matrix/roadmap with precise measured scope and remaining P2.
- [x] Verify unchanged main preimages, copy only task deltas, check final SHA equality and execute proportional main checks.
- [x] Record results and limitations in a scoped report; stop owned fixtures/processes and leave no live provider/database claim.
