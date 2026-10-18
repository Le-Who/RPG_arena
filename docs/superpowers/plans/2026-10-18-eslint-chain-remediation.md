# ESLint chain remediation implementation plan

> **For agentic workers:** Use executing-plans to implement this task with TDD and an independent final review. Track progress below.

**Goal:** Remove the remaining high dependency findings while preserving Next 16 and the current lint rules.

**Architecture:** Keep the existing Next plugin, fast-glob and micromatch unchanged. Override only their braces leaf with a private source-vendored braces 3.0.3 patch that bounds parser/AST recursion, preserving the original grammar and public API. Keep the application and ESLint configuration unchanged.

**Tech Stack:** npm overrides/lockfile, Next 16.3.8, ESLint 9.39.4, private braces 3.0.3-chronicle.1, Node test runner.

**Spec:** The user's request in this chat: resolve the remaining high ESLint dependency vulnerabilities safely, preserve Next 16 compatibility, and repeat checks. The original finding is recorded in [the legacy audit](../../legacy-cleanup-audit-2026-10-18.md).

## Global constraints

- Preserve existing uncommitted work and use the current npm lockfile.
- Keep Next, eslint-config-next and the Next plugin at 16.3.8; keep all lint rules enabled.
- Do not use force updates, advisory suppression, postinstall patches, real campaign databases or provider credentials.
- The patch is private and scoped to the exact installed Next lint dependency chain.
- Historical migrations and runtime application behavior remain unchanged.

## Review focus

- Literal roots must return the directory itself, not its descendants.
- Relative/absolute paths, Windows separators, root arrays and brace/glob patterns must still discover roots.
- Deeply nested brace input must not overflow the parser stack or hang the lint process.
- The real no-html-link-for-pages rule must continue finding internal HTML links.
- Clean installs and the Docker dependency stage must have the local package available before npm ci.

## Task 1: Replace the vulnerable lint-only dependency boundary

**Files:** `tooling/braces/`, `package.json`, `package-lock.json`, `deploy/docker/Dockerfile`, `tests/eslint-next-glob.test.ts`, `tests/eslint-braces.test.ts`.

**Interface:** Preserve the callable braces API and parse/compile/expand/stringify methods. Reject nesting beyond 128 with a controlled SyntaxError carrying ERR_BRACES_DEPTH. The override applies only to `@next/eslint-plugin-next@16.3.8 > fast-glob@3.3.1 > micromatch@4.0.8 > braces`.

- [x] Add real-helper fixture tests for the root-directory contract, a bounded subprocess regression for nested braces, and actual ESLint rule behavior.
- [x] Run against the old dependency and record the stack-overflow RED; verify direct AST entrypoints before the guard patch.
- [x] Add the private security patch, scoped file override and Docker COPY input; preserve every unrelated registry package/metadata entry.
- [x] Pass 40 focused tests, including the independently discovered symlink, numeric-range and globstar cases, and the full audit.
- [x] Verify a clean npm ci, focused tests, npm ls and both full/runtime audits.
- [x] Repeat typecheck, lint, build, npm test and documentation checks in a copy without .env; review the complete change independently.
- [x] Record results and the removal condition for the workaround in the audit report and roadmap. Leave changes uncommitted for review.

## Execution record

- Investigation: latest published braces is still 3.0.3; fast-glob 3.3.3 and the latest Next 16 plugin still retain the vulnerable chain.
- Rejected options: bare tinyglobby alias changes literal-directory semantics; even an adapter with expansion/slash/drive fixes changed numeric ranges, junctions and globstar scope. A brace-expansion replacement also changes bracket/quote/malformed-pattern grammar. These findings favor the original implementation with a small depth patch.
- Packaging: declare the private fork as the root dev dependency named braces and reference it with npm's `$braces` override. A literal relative file spec inside a nested override resolves from the consumer, producing a broken link; the root reference was verified in a disposable install.
- The upstream MIT source/license are retained. Only parser/AST depth guards differ algorithmically; the original index, constants and utility modules remain byte-identical.
- Independent final patch review: no actionable findings, fresh 40/40 focused tests and 9024 differential/boundary assertions. Clean installs, npm ls, full/runtime audits, typecheck, lint, build and minimal Docker install/prune inputs passed. Full sequential npm test passed 1181/1181, with no failures/cancellations/skips/todos. Documentation check passed 89 files/362 local links; 521 non-document inputs remained identical to the verified copy.
- Execution choice: continue the user's authorized fix in the current dirty checkout; use a separate physical copy for clean-install and environment-isolated verification. Preserve earlier changes and do not commit them together.
