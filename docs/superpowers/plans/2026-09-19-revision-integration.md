# Revision Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the strongest compatible backend, accessibility, and design changes from both local revisions while preserving preset offline play and current WebP artwork.

**Architecture:** Use `accessibility-revision` as the coherent v2.2-v2.5 base, then overlay the backend revision's minimap and onboarding. Keep migration history additive, preserve the current offline engine, and adapt all image references to the current root-level WebP assets.

**Tech Stack:** Next.js 16, React 19, TypeScript 5.9, Drizzle ORM, PostgreSQL, Node test runner, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-19-revision-integration-design.md`

## Global Constraints

- Preset campaigns must remain playable without Gemini through `src/lib/engine.ts`.
- Free campaigns without Gemini must return `AI_REQUIRED`.
- Current files in `public/*.webp` and their root-relative URLs must be preserved.
- `accessibility-revision/` and `backend-revision/` are read-only source material and must be excluded from application typechecking/linting/build inputs.
- Existing migration files `0000` and `0001` must not be rewritten.
- Migration `0003` may add `workspace_preferences.reading` but must not drop
  columns or rewrite stored character JSON.
- The backend revision's minimap visual design is retained; the general 12 px text floor does not prohibit its compact internal map markers.

---

### Task 1: Isolate source revisions and establish regression contracts

**Files:**
- Modify: `tsconfig.json`
- Modify: `eslint.config.mjs`
- Modify: `package.json`
- Create: `tests/revision-integration.test.ts`

**Interfaces:**
- Consumes: the current 52-test baseline and the two local revision directories.
- Produces: repeatable `test`/`verify` commands and regression tests that can load the new reading/map/request helpers.

- [ ] **Step 1: Write failing integration-contract tests**

Create tests that dynamically import the not-yet-integrated helpers and assert
literal behavior: invalid reading input normalizes to midnight defaults;
bidirectional map links deduplicate while dangling/self links disappear; and
the v2.2 JSON reader rejects an oversized streamed body.

- [ ] **Step 2: Run the new test and verify RED**

```powershell
$env:DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/rpg_arena_test'
node --import tsx --test tests/revision-integration.test.ts
```

Expected: FAIL because the new helper modules are not present in the root
application.

- [ ] **Step 3: Exclude the source revisions and add repeatable scripts**

Add both revision directory names to TypeScript and ESLint ignores. Add
`test`, `migrate`, `worker`, `audit:ui`, `smoke`, `smoke:v22`, and `verify`
scripts from the accessibility revision without changing dependencies.

- [ ] **Step 4: Verify the unchanged baseline**

```powershell
$env:DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/rpg_arena_test'
npm run typecheck
node --import tsx --test tests/resolution.test.ts tests/upgrade.test.ts
```

Expected: TypeScript passes and the original 52 tests pass.

### Task 2: Integrate v2.2 reliability and additive database structures

**Files:**
- Create/modify: `drizzle/0002_story_branches_and_jobs.sql`, `drizzle/0003_reading_preferences.sql`, `drizzle/meta/_journal.json`, `src/db/schema.ts`
- Create: `src/lib/background.ts`, `checkpoint-snapshot.ts`, `checkpoint-types.ts`, `checkpoints.ts`, `compaction.ts`, `context-budget.ts`, `entity-identity.ts`, `http.ts`, `memory-jobs.ts`, `reading-preferences.ts`, `system-status.ts`, `turn-admission.ts`, `turn-contract.ts`
- Modify: `src/lib/api-client.ts`, `embeddings.ts`, `memory.ts`, `memory-ui.ts`, `resolution.ts`, `turn.ts`
- Create/modify: checkpoint/request/system API routes under `src/app/api`
- Create: `scripts/memory-worker.ts`, `scripts/v22-smoke.ts`, `scripts/v22-browser.ts`
- Modify: `scripts/migrations-check.ts`
- Create: `tests/reliability-v22.test.ts`

**Interfaces:**
- Produces: durable turn leases, replay-safe `TurnResponse`, semantic job queue,
  immutable checkpoint/fork APIs, and `/api/system/status`.

- [ ] **Step 1: Add the v2.2 reliability test suite and verify RED**

```powershell
$env:DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/rpg_arena_test'
node --import tsx --test tests/reliability-v22.test.ts
```

Expected: FAIL on missing v2.2 modules.

- [ ] **Step 2: Mechanically import the coherent accessibility-revision backend**

Copy the exact v2.2 files listed above, including API routes and migration
`0002`. Derive migration `0003` from the accessibility revision but keep only
the additive `workspace_preferences.reading` statement. Preserve root
`src/lib/engine.ts` and its imports so preset offline behavior is unchanged.

- [ ] **Step 3: Run focused reliability and legacy tests**

```powershell
$env:DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/rpg_arena_test'
node --import tsx --test tests/reliability-v22.test.ts tests/resolution.test.ts tests/upgrade.test.ts
```

Expected: all tests pass, including the offline-engine regression.

### Task 3: Integrate the tokenized interface and reading accessibility

**Files:**
- Replace: `src/app/globals.css`
- Create: `src/app/shell.css`, `src/app/pages.css`, `src/app/theatre.css`, `src/app/preferences.css`
- Remove from imports: `src/app/workspace.css`
- Modify: `src/app/layout.tsx`, `src/components/app-shell.tsx`, `dashboard.tsx`, `play-room.tsx`, `settings-panel.tsx`, `story-creator.tsx`, `story-records.tsx`
- Create: `src/components/checkpoint-dialog.tsx`, `system-panel.tsx`, `use-turn-request.ts`
- Create: `src/app/system/page.tsx`
- Create: `tests/experience-v25.test.ts`

**Interfaces:**
- Consumes: workspace `reading` preferences and v2.2 request/checkpoint APIs.
- Produces: tokenized responsive UI, reading themes, keyboard tabs, live turn
  status, skip link, branch controls, and diagnostic UI.

- [ ] **Step 1: Add reading-preference tests and verify RED if not already covered**

```powershell
$env:DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/rpg_arena_test'
node --import tsx --test tests/experience-v25.test.ts
```

Expected before UI/helper import: FAIL; after import: PASS.

- [ ] **Step 2: Import the accessibility revision's UI and CSS layer**

Mechanically copy the files listed above. Preserve existing app behavior and
then replace every `/images/*.jpg` reference with the corresponding existing
root WebP URL such as `/chronicle-hero.webp`.

- [ ] **Step 3: Check types and static asset references**

```powershell
npm run typecheck
rg -n '/images/|\.jpg' src
```

Expected: typecheck passes and the asset search returns no application matches.

### Task 4: Overlay the requested backend minimap and onboarding

**Files:**
- Create: `src/lib/world-graph.ts`, `src/components/world-map.tsx`
- Modify: `src/components/play-room.tsx`, `src/app/theatre.css`, `src/components/dashboard.tsx`, `src/components/app-shell.tsx`, `tests/revision-integration.test.ts`

**Interfaces:**
- `mapEdges<T extends GraphNode>(nodes: T[]): GraphEdge<T>[]`
- `projector(nodes: GraphNode[], inset?: number, spread?: number): (x: number, y: number) => { left: number; top: number }`
- `WorldMap({ locations, currentLocation, onLocationClick })`

- [ ] **Step 1: Verify map graph tests fail against the missing helper**

Run the focused integration test from Task 1 and confirm its map test is RED.

- [ ] **Step 2: Import the backend minimap exactly, adapting only integration seams**

Copy `world-graph.ts`, `world-map.tsx`, and the backend minimap CSS rules.
Integrate the component in the world tab, add first-turn onboarding, and retain
its expand dialog and compact marker sizing. Keep the accessibility revision's
roving tab index, Home/End behavior, `aria-live`, reading preferences, and
offline copy.

- [ ] **Step 3: Add image dimensions without changing WebP URLs**

Apply the backend revision's `width`, `height`, and `loading="lazy"` hints to
dashboard/search images while keeping the current WebP sources.

- [ ] **Step 4: Run map, accessibility, and offline regressions**

```powershell
$env:DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/rpg_arena_test'
node --import tsx --test tests/revision-integration.test.ts tests/experience-v25.test.ts tests/upgrade.test.ts
```

Expected: all pass, including offline engine and map edge/projection behavior.

### Task 5: Documentation and full verification

**Files:**
- Modify: `README.md`, `docs/superpowers/plans/roadmap.md`
- Create: `docs/worker-operations.md`

**Interfaces:**
- Documents the shipped v2.2-v2.5 behavior, offline preset guarantee, worker
  operation, migrations, and verification commands.

- [ ] **Step 1: Update documentation without claiming unverified capabilities**

Use the accessibility revision documentation as the base, preserve the current
WebP and offline statements, and describe the backend minimap as integrated.

- [ ] **Step 2: Run full static verification**

```powershell
$env:DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/rpg_arena_test'
npm run test
npm run typecheck
npm run lint
npm run build
```

- [ ] **Step 3: Run environment-dependent verification where available**

Run migration, smoke, and UI audit scripts only against a confirmed disposable
database/server. Record unavailable prerequisites accurately.

- [ ] **Step 4: Review the final diff against the spec**

Confirm each retained/rejected revision decision, check that source revision
folders remain unmodified and untracked, and ensure no current WebP asset was
deleted.
