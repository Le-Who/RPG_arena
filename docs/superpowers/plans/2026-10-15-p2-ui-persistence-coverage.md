# P2 UI and persistence coverage implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Close the highest remaining local gaps for selected settings, action item identity, owner edits and migration of existing data.

**Architecture:** Call actual settings handlers against disposable PGlite; exercise production React components in isolated Chromium fixtures with literal API payloads and canonical responses; replay the actual numbered migration journal over populated legacy tables. Preserve earlier evidence and distinguish coverage of correct behavior from reproduced regressions.

**Tech Stack:** Node 24, node:test/tsx, PGlite/vector/pgcrypto, Playwright Chromium, esbuild, installed Next 16.3.8.

**Spec:** [Coverage matrix, domains 20, 22 and 24](../../testing/coverage-matrix-2026-10-09.md), [coding standards](../../../CODING_STANDARDS.md).

## Global constraints

- Reuse the attached isolated worktree; main's 568 file preimages are captured before work. Preserve all previous changes. No commit/push or live DB/provider calls.
- Subagents use gpt-6.1-sol, high reasoning for these integration tasks and review. Disjoint ownership; coordinator owns shared docs and final checks.
- Read matching standards and installed Next guides before editing. Production fixes require a retained behavioral RED first; otherwise report original GREEN coverage honestly.
- Historical migrations/journal are immutable. No copied production implementation as an oracle; assert literal values, submitted identities and visible canonical state.
- Current ordinary baseline is 997; archive its LCOV before replacing it. Browser evidence is separate from ordinary runtime registrations.

## Review focus

| Condition | Expected behavior | Owner |
| --- | --- | --- |
| Select external provider, save, reload | Same provider/model/live flag and sealed owner credential | Task 1 |
| Failed/stale save | Draft/key remain available for retry; no false success | Task 1 |
| Keyboard item completion followed by text edit | Correct item IDs reach submitted action; unrelated IDs absent | Task 2 |
| Owner edits return changed canonical fields | Visible state reflects returned canon and focus returns sensibly | Task 2 |
| Existing legacy rows and repeated migration | Existing values/IDs survive, new defaults correct, replay leaves rows and ledger unchanged | Task 3 |

## Task 1: Settings round trip and draft

**Files:** new `tests/provider-settings-roundtrip-p2.test.ts`, new `scripts/settings-draft-p2-browser.ts`; production settings component/library/route only for demonstrated bugs.

- [x] Add actual POST→GET cases across providers/owners, key retention/clear, rejected writes and selected AI config; run with test preload and retain original output.
- [x] Bundle the actual settings component(s), submit explicit failed/stale and successful responses, assert payload/draft/visible state. Run Chromium desktop/mobile and keyboard cases.
- [x] Apply only demonstrated fixes, rerun focused checks, report scope and limitations in `output/p2-ui-persistence-coverage/settings-report.md`.

## Task 2: Composer identity and owner editor completion

**Files:** new `scripts/owner-composer-p2-browser.ts`; production `action-entity-input`, `social-panel`, `commitment-controls`, `arc-finale` only for demonstrated bugs; coordinate before touching `play-room`.

- [x] Exercise keyboard completion through edit and submit using actual components, with exact text and item IDs in payload.
- [x] Exercise successful social/commitment/arc edits with literal API payloads and changed canonical response; assert visible committed fields, modal/editor completion and focus.
- [x] Retain original run, fix only reproduced defects, run desktop/mobile and keyboard verification; report `owner-report.md` in stage output.

## Task 3: Populated legacy migration replay

**Files:** new `tests/legacy-migration-replay-p2.test.ts`; no historical migration edits.

- [x] Reconstruct supported pre-journal legacy schema from existing migration contracts, populate representative session/turn/inventory/memory/settings rows with literal data.
- [x] Apply actual full journal with production `applyMigrations`, assert preserved values and new defaults/relationships/ledger; assert second run is a no-op including data.
- [x] Cover rollback/retry of a populated upgrade where meaningful; run focused tests and write `migration-report.md` with exact supported starting schema and native limitations.

## Task 4: Independent review and consolidated verification

- [x] Independently inspect each task's assertions and production diff; fresh gpt-6.1-sol reviewer checks combined behavior and reruns focused evidence.
- [x] Freeze source/test/scripts/config hashes; run ordinary coverage, typecheck, lint, docs and default isolated Turbopack build with safe environment.
- [x] Update inventory, matrix, roadmap and stage report; preserve historical raw LCOV and browser scope.
- [x] Verify main568 preimages, transfer16 stage files, prove all444 frozen files byte-equal; fresh main7/type/lint pass, docs checked after final prose.

Ruling: user explicitly requested continued implementation with subagents; proceed without an additional plan approval pause. Reuse the existing worktree and owned physical build dependencies after validating their previous hashes.



