# Consolidated revisions implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Integrate the useful contributions from all four revision folders, repairing unsafe implementations and preserving optional guest play; verify behavior and update documentation and roadmap.

**Architecture:** Retain the existing game engine, ownership guards, PostgreSQL transaction model and Next.js app. Introduce a single secret boundary, optional authenticated identity with independent administrative access, durable quota admission and validated portable snapshots. Integrate UI only against these server contracts.

**Tech Stack:** Existing Next.js/React/TypeScript, Drizzle/PostgreSQL, node:test/tsx and PGlite, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-23-revisions-consolidation-design.md` (approved with optional guests, explicit account adoption and admin-only operational surfaces).

## Global Constraints

- User dispatch preference: every newly launched subagent must use `gpt-6-sol` with reasoning `xhigh` (user confirmed after tool rejected unsupported `max`). Do not silently substitute another model/effort. Already-running agents are not restarted.
- User verification cadence: prefer focused tests for each patch; do not repeat the full suite/build for minor fix rounds. Reserve broad verification for the final integrated state or a concrete cross-cutting risk not covered by focused tests.
- `revisions/` is local comparison input only: git-ignored, never committed, excluded from compiler/linter/test/build inputs. Do not stage it or test its copies as the application.

- Preserve existing dependency versions as floors and all existing npm commands.
- Preserve user edits to both roadmap documents. Do not edit revision source folders.
- Do not rewrite migrations `0000–0010`; allocate new journal entries sequentially.
- Do not migrate or rotate secrets in the user's real database or call paid providers for local tests.
- Guests remain able to play, create campaigns, manage their own BYOK settings and export.
- Administrative permission never implicitly overrides campaign ownership.
- Read relevant local Next.js guides before changing framework code.
- Tests run without loading `.env`; use PGlite or explicitly isolated test databases. A dummy connection string may satisfy module initialization only; do not connect it to the user's DB.
- No automatic release/deployment, service installation, push or merge. Work in `E:/Projects/RPG_arena` on `codex/revisions-consolidation`.

## Task 1: Unified protected settings and secret rotation

**Files:** create `src/lib/secret-vault.ts`, `scripts/rotate-secrets.ts`, `tests/secret-vault.test.ts`, `tests/secret-settings.test.ts`; modify `src/lib/ai-settings.ts`, `src/lib/narrative-settings.ts`, `src/lib/typesafe-settings.ts`, `src/app/api/settings/route.ts`, `.env.example`, `package.json`. Test isolated SQL via a test helper if required. Existing schema stays unchanged.

**Interfaces:** use Astra's `SecretKeyring`, `secretContext(ownerId, purpose)`, `sealSecret`, `openSecret`, `decodeSettingsSecrets`. `getSettingsRow(ownerId?)` continues returning decoded settings to existing server consumers. Writers persist sealed values with the same owner/purpose contract; settings HTTP responses remain masked. Preserve existing API return shapes with optional safe storage-status fields.

- [x] Write behavior tests using explicit keyrings. Tests must fail before source integration. Example:

```ts
const ring = { active: 'test-v1', keys: { 'test-v1': Buffer.alloc(32, 7).toString('base64') } };
const sealed = sealSecret('test-api-key', secretContext('owner-a', 'gemini'), ring);
assert.equal(openSecret(sealed, secretContext('owner-a', 'gemini'), { keyring: ring }), 'test-api-key');
assert.throws(() => openSecret(sealed, secretContext('owner-b', 'gemini'), { keyring: ring }));
assert.throws(() => openSecret('old-plain', secretContext('owner-a', 'gemini'), { keyring: ring }));
```

- [x] Cover fresh-IV uniqueness, tampering, malformed keyrings, unknown versions, missing key material, empty secrets, explicit legacy-read permission, old-key reads and resealing. Cover safe raw write/decode round-trip for Gemini/Jev/narrative credentials, provider change with unchanged narrative credential, clear-key behavior and masked views. An unrelated broken credential must not be silently erased.
- [x] Run `node --import tsx --test tests/secret-vault.test.ts tests/secret-settings.test.ts`; record expected missing-feature failure.
- [x] Adapt Astra's implementation, not its package manifest. Enforce strict key material and owner/provider AAD. Preserve existing settings concurrency semantics or strengthen touched writer updates to avoid read/decrypt/reseal clobbering unrelated fields. No ORM-wide decoder which hides raw data from rotation.
- [x] Add rotation modes `--check`, `--dry-run`, `--apply` (no writes without explicit apply). Use bounded batches and compare-and-swap raw values or row locks. Unknown/unreadable data produces an error without overwriting. Never print plaintext, key material or connection strings. Test rotation against isolated fixtures; reusable rotation logic may live in `src/lib/secret-rotation.ts`.
- [x] Update `.env.example` and add the `rotate:secrets` npm command. Coordinate the additive `check:docs` command with the independently implemented Task 6 checker; do not replace existing commands. Do not run rotation on the user's `.env`.
- [x] Run focused tests, `npx tsc --noEmit` after revisions are excluded by Task 0, and existing settings/narrative tests. Commit only task-owned files and report test evidence and any unresolved defects.

## Task 0: Source isolation and baseline (controller)

**Files:** `tsconfig.json`, `eslint.config.mjs`, `.gitignore`; no application behavior change.

- [x] Run existing suite before source changes: `node --import tsx --test --test-concurrency=1 tests/*.test.ts`.
- [x] Exclude `revisions`, `.agents`, `.superpowers` from compiler/linter discovery without removing historical exclusions. Do not ignore actual production tests.
- [x] Keep `.superpowers/` local execution artifacts untracked; keep source revisions available for audit, outside application build.
- [x] Record baseline test count and any pre-existing failures separately from integration defects.

## Task 2: Optional accounts and administrative boundaries

**Files:** new `src/lib/auth.ts`, `src/lib/auth-policy.ts`, `src/lib/admin-access.ts`, auth API, migration and tests; modify identity resolver, schema, proxy, system/developer routes, narrative diagnostic route and TypeSafe worker config. Account UI integrates in Task 5.

**Interfaces:** `currentIdentity()` returns `{kind, profileId, account, guestProfileId, isAdmin}`; `currentProfileId()` remains compatible. `requireAdmin()` resolves current identity and rejects non-admin before side effects. Worker permission is checked from explicit owner identity, never request cookies.

- [x] First add PGlite behavioral tests for registration claim, login/logout, old guest token rejection, cross-device session revocation, concurrent claim/adoption, explicit adoption with replay, origin checks and rate limits. Example acceptance: after claiming guest profile G for account A, resolving G without A's valid session must not return G as an authorized profile.
- [x] Allocate accounts, sessions, consumed guest profiles and durable rate-limit storage after current journal. Derive target owners from DB; no client-supplied administrator flag. Tokens are random, stored hashed, with httpOnly cookies; no positive authorization cache surviving revocation.
- [x] Adapt Fable1 account logic with the spec's guest lifecycle: register adopts, first logout empty; subsequent login never silently adopts; declined adoption retains the guest cookie for access after logout. Explicit adoption is transactional and locks against competing claims. Do not overwrite account keys/settings with guest settings.
- [x] Implement server allowlist of account IDs from `CHRONICLE_ADMIN_ACCOUNT_IDS`, deny all when absent. `/system` returns 404 without access, APIs 403 before processing. Guard system, developer Jev and narrative diagnostics; keep the latter's ownership requirement. Do not make own memory/settings admin-only.
- [x] Test disabled legacy Jev pilot in non-admin worker execution, not merely hidden UI. Add permission disclosure to safe workspace/auth response for UI filtering.
- [x] Verify all guest/account/admin routes through real handlers or isolated HTTP smoke and focused tests. Commit task files; document configured-role restart semantics.

## Task 3: Per-attempt atomic quotas

**Files:** `src/lib/quota.ts`, quota migration/schema, `gemini-transport.ts`, `ai-settings.ts`, `turn.ts`, `memory-jobs.ts`, `compaction.ts`, autofill and embedding call paths, isolated quota tests.

**Interfaces:** `reserveModelCall({ownerId, scope, model, day, cap})` atomically returns admission; transport hook is called before each actual provider attempt. Quota ownership comes from the effective settings owner.

- [x] Write SQL concurrency tests: cap=3 with 12 concurrent requests admits exactly 3; owner/model/scope/day isolation; cap=0 sends no external request. Add transport tests observing actual mocked fetch count after real reservation logic, including retries/fallback.
- [x] Adapt Fable2 UPSERT into one admission boundary. Validate timezone instead of silently falling back. Preserve explicit enforceLimits behavior. Default multiple keys to shared project limits; independent limits require explicit configuration.
- [x] Cover main turn, review, repair, draft autofill, semantic extraction, compaction and embeddings. Record all paths in the audit; independent provider scopes must not be mislabeled as one universal quota.
- [x] Seed existing current-day usage on migration without double counting; distinguish definitive denied attempts from ambiguous network outcomes. Do not refund ambiguous calls automatically.
- [x] Run focused transport/SQL tests, settings regressions and full typecheck; document local budget versus provider billing. Commit.

## Task 4: Portable campaigns

**Files:** `campaign-portable.ts`, `campaign-copy.ts`, import/export API, portable tests; preserve checkpoint contracts.

**Interfaces:** versioned `{format:'chronicle-campaign', schemaVersion:1, checksum, exportedAt, engine, title, snapshot}`; owner-bound request identity and payload fingerprint for replay/conflict detection.

- [x] Add tests rejecting malformed nested fields, invalid enums/dates/numbers, duplicate IDs, cross-campaign references, excessive size and invalid agreement provenance. Assert user-supplied extra fields never override owner, visibility or runtime controls.
- [x] Combine Fable2 reusable snapshots with Fable1 structural validation, expanded to allowlisted rows. Round-trip via real isolated DB with remapped structured IDs, no keys/billing/jobs/request IDs, fresh embedding outbox.
- [x] Export owner-only from a consistent snapshot while a turn is concurrent. Keep Markdown export unchanged.
- [x] Test 12 simultaneous identical import requests return one campaign; same request ID with a different payload is 409; failure rolls back all inserted rows. Implement serialization and payload ledger as necessary with a new migration.
- [x] Run focused checkpoint/copy/import tests and typecheck; commit.

## Task 5: User experience and accurate public explanations

**Files:** Astra overview/palette/style and affected shell/dashboard/world/applied changes components; account/import components; `/blueprint`; browser regression script.

**Interfaces:** consume server-computed identity/admin capabilities, never infer authorization from localStorage. Scope local recent commands and favorites to profile.

**User-added modal review:** dialogs must be evaluated as focused overlays, not full page layouts cropped into a constrained viewport. Review the shared `Dialog` and its settings, story creation, checkpoints/branches, world map, search/command palette, guide and updates consumers. If a page component is reused, provide an explicit modal presentation: no duplicate page header/breadcrumb/footer chrome, appropriate compact heading and actions, purpose-sized width, one intentional body scroll region with header/primary actions remaining reachable. Preserve dirty-state guards and suspended-dialog return behavior. Do not mechanically shrink all page text or clip content to fit.

- [x] Add browser scenarios first for optional guest play, registration with campaigns, logout, explicit later adoption, admin menu visibility and direct forbidden navigation, portable round-trip, command focus and narrow viewport.
- [x] Adapt Astra UI while retaining images, reading themes/reduced motion, restoration and dirty-dialog safeguards; account/import UI from corrected server contracts.
- [x] Remove developer/admin cards and commands for ordinary visitors. Keep own memory/usage/settings accessible. Avoid fetching admin endpoints for ordinary users.
- [x] Update `/blueprint`, version labels, update dialog and privacy copy from actually implemented state, not revision release claims. Public help remains public.
- [x] Run browser scenarios, inspect screenshots at desktop/mobile, accessibility checks and relevant tests. Commit.
- [x] **Modal display gate:** capture desktop and 390px mobile screenshots of each distinct dialog layout; check long content, large reading text/200%-equivalent layout, no horizontal clipping, readable controls, overlay/backdrop separation and background scroll lock. Verify keyboard focus containment, Escape, return focus, nested settings-over-creator/checkpoint flows, dirty-form confirmation and restoration. Compare against the surrounding page and correct any page-in-a-small-window layout. Record concrete screenshots/results, not merely that the dialog opens.

## Task 6: Operations, reproducibility and documentation

**Files:** queue-health/readiness, worker heartbeat and startup-migration modules, deployment templates, `.dockerignore`, CI, lockfile, docs checker, README, operational documents, both roadmaps and final comparison report.

- [x] Test per-instance heartbeat: stopping instance A does not report B as stopped. Test readiness returns minimal public status without detailed DB/config leaks.
- [x] Adapt optional startup migrations using existing advisory transaction lock; rejection must propagate and prevent readiness. Test fresh schema, repeat apply and failed migration on isolated DB; web and worker use explicit consistent modes.
- [x] Create lockfile without dependency downgrades; build deployment templates excluding `.env`, revisions, local output and execution scratch. CI runs reproducible install, typecheck/lint/tests/docs/build and isolated migration repeat.
- [x] Test documentation checker against valid and broken fixture paths and command references. Run it across current documentation; distinguish historical plans from current operational commands.
- [x] Write final comparison report tracing all substantive revision changes and attached recommendations to accepted/adapted/deferred outcomes. Update existing roadmap content without discarding user priorities, clearly separating verified/local/live/unperformed gates.
- [x] Run full suite, lint, typecheck, build, docs validation, isolated migration checks and complete browser flows. Complete integration review with independent scoped reviews; account security review was unavailable, so record primary-review evidence and do not claim an independent security audit. No completion claim before evidence covers the full spec.

## Execution record

Progress and task review artifacts live in `.superpowers/sdd/2026-09-23-revisions-consolidation/`. Tasks 0–6 are locally complete. Final evidence and explicit unperformed deployment/security-audit gates are recorded in `docs/revision-integration-review-2026-09-23.md`. Substantive revision changes were reviewed per task; the unavailable independent account security review was not retried or rerouted. Repeated full test passes were avoided per user instruction: later UI corrections used focused browser/lint checks.
