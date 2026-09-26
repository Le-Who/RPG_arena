# Revision 2.7 Review and Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compare `revisions/2.7-revision` with the current Chronicle Engine tree, integrate only changes that are correct and compatible, improve viable rejected ideas, and update the roadmap and operational documentation with evidence.

**Architecture:** Treat the current `main` tree as the source of truth for the already accepted account, quota, portability, readiness, and narrative work. Review the revision as a candidate patch: first isolate semantic differences from line-ending noise, then validate each candidate against the current data model, ownership boundaries, migrations, server routes, UI contracts, and tests. Integrate the world-life/scene-visuals slice only after its API and persistence boundaries are made owner-safe and its migration is represented in the Drizzle journal.

**Tech Stack:** Next.js 16, React 19, TypeScript 5.9, Drizzle ORM/PostgreSQL, Node test runner with `tsx`, Playwright smoke scripts.

**Spec:** `docs/superpowers/specs/2026-09-23-revisions-consolidation-design.md` plus the candidate material in `revisions/2.7-revision/docs/`.

## Global Constraints

- Preserve the current accepted identity, ownership, quota, portability, readiness, worker, and narrative-verification invariants.
- Do not copy the revision wholesale; normalize line endings before comparing and review semantic changes only.
- Every new behavior must have a focused regression test; write and run the failing test before production implementation when behavior changes are needed.
- Keep migrations append-only and update `drizzle/meta/_journal.json` consistently with any imported migration.
- Never rewrite an already applied migration to introduce an optional backend. The candidate's no-pgvector edits to `0006`/readiness are a deferred architecture item and are not part of this integration.
- Every session-scoped API must enforce the existing owner/admin policy before reading or mutating data.
- Update both roadmap documents and the relevant operational docs to distinguish implemented, adapted, deferred, and rejected ideas.
- Before claiming completion, run fresh typecheck, lint, unit tests, build, docs checks, and the focused world-life/visual tests.

---

### Task 1: Establish the semantic diff and review record

**Files:**
- Create: `docs/superpowers/plans/2026-09-24-revision-2-7-review.md`
- Create: `docs/revision-2.7-integration-review-2026-09-24.md`
- Read: `revisions/2.7-revision/docs/revision-integration-review-2026-09-23.md`
- Read: `docs/development-roadmap-2026-09-20.md`
- Read: `docs/superpowers/plans/roadmap.md`

**Interfaces:**
- Consumes: normalized file diff and current repository invariants.
- Produces: an auditable candidate table with one decision per substantial revision change: `integrate`, `adapt`, `defer`, or `reject`, including a reason and verification evidence.

- [x] **Step 1: Compare files after normalizing CRLF/LF and list only semantic changes.**
- [x] **Step 2: Read every new world-life/visual file and each true modified file that changes runtime behavior.**
- [x] **Step 3: Record risks, missing dependencies, and ownership/security gaps in the review document.**

### Task 2: Validate persistence and migration compatibility

**Files:**
- Modify only if justified: `src/db/schema.ts`, `drizzle/0014_scene_visuals.sql`, `drizzle/meta/_journal.json`
- Do not modify: `drizzle/0006_database_memory_search.sql`, `src/lib/readiness.ts` for the rejected no-pgvector mode
- Test: `tests/deploy-migrations.test.ts`, focused schema/migration tests as needed

**Interfaces:**
- Consumes: current Drizzle schema and migration journal.
- Produces: an append-only, replayable schema change with deterministic ownership/session foreign keys and no collision with current migration history.

- [x] **Step 1: Verify whether the candidate migration is new, complete, and represented in the journal.**
- [x] **Step 2: Add a failing migration/schema test for every missing invariant discovered.**
- [x] **Step 3: Implement the minimal compatible schema and journal changes.**
- [x] **Step 4: Run focused migration and schema tests, then the full migration test.**

### Task 3: Integrate world-life and scene-visual behavior safely

**Files:**
- Add/adapt: `src/lib/world-life.ts`, `src/lib/interactions.ts`, `src/lib/visuals.ts`, `src/lib/visual-provider.ts`
- Add/adapt: `src/app/api/sessions/[id]/visuals/route.ts`, `src/app/api/sessions/[id]/visuals/[visualId]/route.ts`, `src/app/api/sessions/[id]/visuals/identities/route.ts`
- Add/adapt: `src/components/entity-actions.tsx`, `src/components/life-panel.tsx`, `src/components/visual-gallery.tsx`, `src/app/life.css`
- Modify only where integration requires: `src/app/api/sessions/[id]/route.ts`, `src/app/api/sessions/route.ts`, `src/components/play-room.tsx`, `src/components/story-creator.tsx`, `src/lib/turn.ts`, `src/lib/resolution.ts`
- Tests: `tests/world-life.test.ts` and focused route/ownership/turn tests

**Interfaces:**
- Consumes: existing session ownership, turn admission, committed-turn, campaign, and visual-provider contracts.
- Produces: owner-scoped scene visual metadata and world-life interactions that cannot mutate another campaign, bypass turn fencing, leak provider credentials, or call a live provider in unit tests.

- [x] **Step 1: Write failing tests for owner isolation, invalid visual references, idempotent interaction application, and provider fallback.**
- [x] **Step 2: Run the focused tests and confirm the failures identify missing behavior rather than test setup errors.**
- [x] **Step 3: Implement the smallest compatible library and route changes.**
- [x] **Step 4: Add UI wiring only after the server contract is tested.**
- [x] **Step 5: Run focused tests and the existing turn/session suite.**

### Task 4: Reconcile candidate edits to existing systems

**Files:**
- Review/adapt: `src/lib/applied-changes.ts`, `src/lib/readiness.ts`, `src/lib/resolution.ts`, `src/lib/turn.ts`, `src/components/play-room.tsx`, `src/components/story-creator.tsx`, `src/db/schema.ts`
- Tests: affected existing suites plus new regression tests

**Interfaces:**
- Consumes: current accepted implementation and the revision's deltas.
- Produces: no regressions in current account, quota, narrative, portability, and readiness flows; viable revision ideas are adapted instead of copied when their assumptions differ.

- [x] **Step 1: Diff each true-modified file against current behavior and identify changes that are only formatting, stale context, or destructive replacement.**
- [x] **Step 2: For each viable behavioral delta, add or extend a failing regression test.**
- [x] **Step 3: Port the delta without regressing current invariants.**
- [x] **Step 4: Run affected suites and inspect failures before making additional changes.**

### Task 5: Update roadmap and operational documentation

**Files:**
- Modify: `docs/development-roadmap-2026-09-20.md`
- Modify: `docs/superpowers/plans/roadmap.md`
- Create/modify: `docs/revision-2.7-integration-review-2026-09-24.md`
- Modify as needed: `docs/world-life-and-visuals.md`, `README.md`, relevant operations docs

**Interfaces:**
- Consumes: the final integration decisions and fresh verification output.
- Produces: documentation that states what is implemented, what was adapted, what remains deferred, and what live/external checks were not run.

- [x] **Step 1: Add the review matrix and evidence links.**
- [x] **Step 2: Update both roadmaps with current status, dependencies, and next measurable gates.**
- [x] **Step 3: Document configuration, ownership, provider behavior, migration, and rollback/operational limits.**
- [x] **Step 4: Run `npm run check:docs` and the docs test.**

### Task 6: Full verification and completion report

**Files:**
- No production changes unless verification exposes a concrete defect.

- [x] **Step 1: Run `npm run typecheck`.**
- [x] **Step 2: Run `npm run lint`.**
- [x] **Step 3: Run `npm test` (402/402).**
- [x] **Step 4: Run `npm run build` (с фиктивным loopback `DATABASE_URL`).**
- [x] **Step 5: Run `npm run check:docs`; browser/UI checks are recorded as deferred because no disposable server/database was started.**
- [x] **Step 6: Record exact results and known unverified external/live-provider limits in the review document and final response.**
