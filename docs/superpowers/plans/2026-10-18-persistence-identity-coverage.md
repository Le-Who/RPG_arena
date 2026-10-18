# Persistence and identity boundary coverage implementation plan

> **For agentic workers:** use `dispatching-parallel-agents` for the three independent scopes below. The user requested execution with `gpt-6.1-sol`; continue in the current checkout, preserve other work and do not commit or push. Use TDD for any production correction and verify the combined result before reporting completion.

**Goal:** strengthen the remaining tests where an ambiguous identity or malformed persisted value could corrupt canonical state or credentials.

**Architecture:** exercise the existing production functions and SQL through disposable PGlite. Keep successful existing behavior, distinguish additional coverage from reproduced defects, and make only corrections demonstrated by failing tests.

**Tech stack:** Next.js 16.3.8 local guides, TypeScript, Node test runner/tsx, PGlite, existing account/turn fixtures.

**Spec:** [coverage matrix](../../testing/coverage-matrix-2026-10-09.md), especially rows 4/5/14/19, and [coding standards](../../../CODING_STANDARDS.md).

## Global constraints

- Preserve `preset`/`free`, `d20`/`rules-light`/`narrative`, Russian user-facing copy and existing persistence formats.
- Models propose changes; deterministic server rules establish identity and accepted state. Uncertainty cannot establish ownership or select an arbitrary canonical entity.
- No real campaign database, provider credentials, paid evaluation, dependency changes or historical migration edits.
- Read the test environment before narrowed runs; include `--import ./tests/helpers/test-environment.ts`.
- Keep the previous LCOV and record raw Node/V8/tsx counters only as evidence for loaded modules, not original TypeScript or whole-application percentages.

## Review focus

- Malformed saved snapshots with a valid checksum must fail before creating a partial branch; supported old snapshots remain usable.
- Exact byte/entity limits must reject excess without silently truncating a saved campaign.
- Stable recipient identity takes precedence over an unrelated display name; ambiguity cannot depend on array order.
- Generic item acquisition must not invent unsupported ownership provenance.
- Concurrent credential changes and late decryption failure must preserve the whole affected profile; partial progress across profiles must remain recoverable.

## Task 1: checkpoint boundaries

**Files:** create `tests/checkpoint-boundaries.test.ts`; change `src/lib/checkpoint-snapshot.ts` or `src/lib/checkpoints.ts` only for a reproduced defect.

**Interfaces:** existing `assertSnapshot`, `snapshotChecksum`, `createCheckpoint`, `forkCheckpoint`; `accountsDb` for migrated disposable SQL.

- [x] Inspect current snapshot/portable/checkpoint tests and select missing bounded/legacy scenarios.
- [x] Test exact UTF-8 byte and entity caps, supported legacy optional agreements, and malformed persisted snapshot shapes with valid checksums. Assert error categories and no partial durable branch state through the real services where appropriate.
- [x] Run on original source; retain initial GREEN and genuine RED separately. Correct only the demonstrated root cause, then rerun affected persistence tests. Original 44: 9 GREEN/35 RED; corrected 44/44 and adjacent 52/52 passed.

## Task 2: transfer identity

**Files:** create `tests/transfer-identity.test.ts`; change `src/lib/world-life.ts` only for reproduced defects.

**Interfaces:** existing `applyLife`, production `performTurn`, migrated PGlite fixture; no new provider wire fields.

- [x] Test exact NPC-key versus display-name collision, duplicate/ambiguous names and array order, with successful exact-key/name/current-location controls.
- [x] Assert literal inventory deltas, holdings, memory/applied changes and immutable inputs. Trace same-name acquisition before deciding whether a return-provenance correction is justified.
- [x] Reproduce a genuine failure before a minimal correction; add durable turn evidence for the accepted fix and rerun adjacent state tests. Original 29: 12 GREEN/17 RED; corrected 29/29 and adjacent 83/83 passed.

## Task 3: credential rotation boundaries

**Files:** create `tests/secret-rotation-boundaries.test.ts`; change `src/lib/secret-rotation.ts` only if the new tests reproduce a defect.

**Interfaces:** existing `rotateSecrets` query callback, real PGlite SQL and crypto with synthetic key material.

- [x] Exercise concurrent changes to each protected column, SQL NULL transitions and deletion between SELECT and UPDATE; assert preservation of complete rows and termination before later rows.
- [x] Exercise multiple keyset batches, already-active/blank/old-key/plaintext credentials, late unreadable credentials, partial progress and retry recovery.
- [x] Record coverage-only GREEN honestly; do not create production changes to manufacture a defect. Original source: 12/12 passed; no production rotation changes.

## Task 4: combined verification and evidence

**Files:** this plan; dated report under `docs/`; coverage matrix/inventory and main roadmap, maintained by coordinator only.

- [x] Complete the pristine full baseline before allowing production edits. 1032/1032 passed; six pre-existing cases beyond the prior 1026 were reconciled by name and excluded from this stage's additions.
- [x] Obtain an independent `gpt-6.1-sol` review of the combined diff and resolve actionable findings. No actionable findings; independent main73/73 plus unchanged rotation12/12, exact reviewed hashes preserved.
- [x] Freeze source/test inputs; run the full ordinary suite with coverage, typecheck, lint, documentation checker and an isolated production build where warranted. Full1117/1117 (1032 retained +85 new), type/lint/build passed on494 matching inputs; final documentation86files/355links passed.
- [x] Update the evidence map with actual counts and explicit limits; report the remaining priorities without declaring unrelated live/native/browser work complete. Physical membership228source/153tests,132ordinaryfiles/757ASTcalls,176loaded/52not-loaded raw V8 records and all historical artifacts verified; pre-existing JSON-envelope file indexed separately.
