# Native ESLint 10 plugins implementation plan

> **For agentic workers:** Use executing-plans for the local implementation and a fresh independent review for the final result. Research subtasks are read-only.

**Goal:** Remove the ESLint compatibility layer and peer overrides only if native React, JSX a11y and import plugins preserve the existing lint contract and improve maintenance.

**Architecture:** Compare the current complete Next flat configuration with native candidates in an isolated npm project. The acceptance boundary is all 17 active React rules, six accessibility warnings, import diagnostics, hooks, Next rules, parsers and existing autofixes. Retain the installed stack if the available replacements lose diagnostics or require a larger local compatibility layer.

**Tech Stack:** Next 16.4.2, ESLint 10.13.0, TypeScript 5.9.3, Node.js 24.13.0, npm, node:test.

**Spec:** The user's current request and the acceptance contract above; the previous migration evidence is in [eslint10-migration-2026-10-18.md](../../eslint10-migration-2026-10-18.md).

## Global constraints

- Preserve current rule behavior and severity, Next 16, supported Node 20/22/24 range and the braces depth patch.
- Keep unrelated working-tree edits and immutable migrations intact. Never use force/legacy-peer-deps or real provider credentials/databases.
- Avoid a newly maintained private React fork or a large copied Next configuration merely to remove a small official compatibility dependency.

## Review focus

- Class components, JSDoc recognition and state update operators must retain diagnostics.
- Native rule-name aliases must preserve behavior, not just provide similarly named rules.
- Accessibility Image options, warning levels and import corrections must stay equivalent.
- Replacing configured plugin objects must not leave hidden legacy peers in the installed graph.
- Clean-install, audit and full-suite results must refer to the final unchanged source inputs.

## Task 1: Establish candidate parity

**Files:** evidence under `output/native-eslint-plugins-2026-10-18/`; extend `tests/eslint-toolchain-compat.test.ts` for reproduced gaps.

- [x] Verify primary release/peer/engine metadata and all 17 active React rule mappings.
- [x] Install native candidates in a disposable project with ordinary npm and no overrides.
- [x] Run invalid and corrected fixtures against installed and native rules; record lost diagnostics and test both JSX and TSX.
- [x] Decide whether full or partial migration meets the complete contract. Record the maintenance tradeoff explicitly.

Ruling: retain the current dependency/configuration stack. Native React loses diagnostics in 14 JSX/TSX cases, including state updates and JSDoc component recognition. The two native state-assignment positive controls prove the rule is running. The a11y/import replacements pass the tested 24/22 cases and ordering fix, but adopting them alone retains React's bridge/peer exception and adds configuration maintenance. The cost of deferral is keeping the documented compatibility dependency; the benefit is preserving the user's complete rule contract without owning additional React rule ports.

## Task 2: Deliver the accepted result

**Files:** `package.json`, `package-lock.json`, `eslint.config.mjs` only if the candidate passes; investigation report, tests and roadmap in either outcome.

- [x] Apply only improvements that satisfy parity; retain existing dependencies if native React support is insufficient.
- [x] Run focused regressions, clean npm ci/tree/audits, types, lint, build and the full standard npm test command on a physical copy without private env files.
- [x] Obtain an independent review, address material findings, run documentation checks and verify frozen input hashes.

Commits and publishing are outside this task. The source workspace already contains user changes and previous completed audits.
