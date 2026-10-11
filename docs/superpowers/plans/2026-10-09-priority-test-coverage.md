# Priority test coverage implementation plan

> **For agentic workers:** Execute the independent tasks with `dispatching-parallel-agents`; the coordinator owns verification and documentation. Track completed steps below.

**Goal:** Close the highest priority reproducible gaps in turn atomicity, route authority and campaign-scoped map writes.

**Architecture:** Call actual production services and Next handlers. PGlite supplies migrated SQL for deterministic boundaries; independent native PostgreSQL connections supply turn contention and fencing. Replace only external provider transport with synthetic fixtures.

**Tech Stack:** npm, node:test, tsx, PGlite, PostgreSQL 16.15, Next.js 16.3.8.

**Spec:** [Coverage matrix](../../testing/coverage-matrix-2026-10-09.md), domains 1, 4 and 12; [coding standards](../../../CODING_STANDARDS.md).

## Global constraints

- No real campaign database, provider credentials, paid calls or deployment.
- Historical migrations and the Drizzle ledger remain unchanged.
- Tests assert independent literal results, persistent effects and rejection before effects.
- Preserve preset/free and d20/rules-light/narrative behavior and Russian product copy.
- Existing code is covered without changing it merely to make a test fail. A reproduced defect must have a failing regression before its minimal fix.
- Work in the attached isolated worktree. No worker commits, modifies shared helpers, changes unrelated files or spawns agents. The coordinator delivers verified files back to the original checkout.

## Review focus

- Concurrent repeats must reach provider transport once and persist one player/narrator pair.
- Expired and replaced leases must reject stale commits without corrupting the current request.
- Failure during request completion must roll back state, turns and jobs together.
- Public readers and foreign administrators must not mutate or export portable JSON.
- Identical map names in different campaigns must not produce foreign writes or phantom applied changes.

### Task 1: Native turn contention, fencing and rollback

**Files:** Create `tests/integration/turn-postgres.integration.ts`; modify `tests/narrative-turn-integration.test.ts` only if needed for deterministic rollback coverage; minimal production fixes only after reporting a reproduced defect.

**Interfaces:** Actual `performTurn`, `acquireTurn`, lease validation and completion in `src/lib/turn.ts` / `turn-admission.ts`. Follow existing opt-in native integration fixtures and use dedicated random schemas.

- [x] Add six simultaneous same-request callers with a controlled provider barrier; assert one provider call, one committed pair, one request and one set of jobs, and exact replay result.
- [x] Expire an admitted lease, replace its token with a new attempt, release the old attempt and assert stale work cannot commit or overwrite the replacement.
- [x] Inject a SQL failure at completed request persistence and assert literal before/after campaign state, turns and jobs demonstrate atomic rollback.
- [x] Execute focused fixtures without skip on disposable PostgreSQL; document any excluded vector migration or untested vector path.

### Task 2: Actual route authority matrix

**Files:** Create `tests/route-authority.test.ts`; minimal route fixes only after reporting a reproduced defect.

**Interfaces:** Real cookie identity storage and migrated PGlite through existing `accountsDb` / `cookieContext`; actual session act, polling, turns, checkpoint/fork/copy, memory/reindex/read and export handlers.

- [x] Assert explicit owner, public reader, foreign administrator and private foreign campaign outcomes at the actual handler boundary.
- [x] Assert literal persisted state and side-effect counters after denied writes and portable exports; include successful permitted reads and owner operations as controls.
- [x] Cover identity revocation during a delayed body if the actual route exposes this boundary; synchronize by events, not arbitrary sleeps.
- [x] Run the focused safe-preloaded test file and report covered versus deferred routes.

### Task 3: Map writes under campaign name collisions

**Files:** Create `tests/location-ops-db.test.ts`; minimal fixes in `src/lib/location-ops.ts` only after reporting a reproduced defect.

**Interfaces:** Actual `executeLocationOp` path in location operations and resolution, existing migrated `accountsDb` fixture. Determine the exported consumer that reaches the actual executor before writing assertions.

- [x] Seed two campaigns with equal location names and distinct endpoints; apply operations to one campaign and assert exact rows in both campaigns.
- [x] Exercise ambiguous same-campaign names and foreign references and assert no phantom applied change, event or wrong link endpoint.
- [x] Verify an appropriate controlled mutation makes an assertion fail, restore production bytes and rerun focused tests.
- [x] Report precise execution coverage and any unchanged-code assumptions.

### Task 4: Integration review and delivery

**Files:** Update the coverage matrix, inventory, main roadmap and add a scoped report.

- [x] Review each task's diff and evidence; obtain independent final review on `gpt-6.1-sol` with reasoning suited to concurrency and authorization.
- [x] Run full `npm run test:coverage`, typecheck, lint, documentation checker, plus opt-in native tests without skip.
- [x] Refresh inventory entries without replacing historical evidence or claiming original-TypeScript/whole-application percentages.
- [x] Copy only verified source/test/doc deltas into `E:\Projects\RPG_arena`, verify SHA256 equality and rerun proportional delivery checks.
