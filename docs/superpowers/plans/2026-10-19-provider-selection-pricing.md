# Independent AI services, pricing and clearer settings — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Ship independent narrator/image providers, shared service credentials, truthful prices and short model lists, with concise Russian UI and contextual help.

**Architecture:** Preserve the current narrator and visual pipelines. Add provider-aware image preferences and immutable image routing snapshots, a normalized pricing catalog, and credential-only writes. Compose the settings screen from two independent tasks and shared connections; use the existing Dialog for secondary explanations.

**Tech Stack:** Next 16.4.2, React 19, TypeScript, Drizzle/PostgreSQL, Node >=22.23.2 <23, existing npm lockfile.

**Spec:** [Approved design](../specs/2026-10-19-provider-selection-pricing-design.md). User approved implementation, review, deployment, commits and push on 19 October 2026, adding question-mark help and an audit of existing UI copy. Proceed continuously within that authorization.

## Global Constraints

- Russian user copy; retain preset/free and d20/rules-light/narrative flows.
- Keys remain encrypted and server-side, scoped to the current owner; no silent payer/model/provider fallback.
- Append-only migrations after 0020; preserve historical image defaults and retries.
- Catalogs never block bootstrap or unrelated settings saves; late responses preserve drafts.
- Pricing is fixed/estimated/unknown with units, source and checkedAt; unknown is not zero.
- Isolated local tests only; no real provider keys or database inherited. Production deployment and guest/account verification are authorized. Do not run paid generation without additional explicit authorization.

## Review Focus

- A shared key removed while the other task uses it must show the resulting unavailable connection without changing that task's preferences.
- Required-image aliases/manual IDs and SVG-only endpoints must not bypass generation eligibility.
- Non-comparable image billing units and extra fees must not receive a misleading cheapness ranking.
- Provider failures, revoked credentials, ownership changes and retries must retain the recorded payer and endpoint.
- Async catalog/save/connection updates must not erase a more recent draft or close it prematurely.

### Task 1: Provider-aware visual persistence and shared credentials

**Files:** src/lib/visual-provider.ts, visual-settings.ts, visuals.ts, text-provider-settings.ts; src/db/schema.ts; drizzle/0021* and ledger; API settings provider-connections route; focused visual/provider/settings tests.
**Interfaces:** Produce visual preferences with provider pollinations|openrouter, enabled, accountSource, model, endpoint; preserve legacy input. GET/POST /api/settings/provider-connections returns configured flags only; POST provider + apiKey/clearKey attaches/removes one service key without changing narrator/visual selections. Reuse existing Gemini storage and encrypted text:openrouter/text:pollinations contexts. Image requests snapshot provider/model/payer/endpoint; OpenRouter is personal only.

- [x] Add and run failing tests for independent preferences, shared credential-only writes, legacy defaults and retry snapshots.
- [x] Implement append-only storage changes and bounded OpenRouter POST /api/v1/images adapter; decode validated raster base64 under existing byte/deadline limits; never fetch arbitrary output URLs.
- [x] Run focused regressions and migration fresh/replay checks; record evidence and changed files.

### Task 2: Catalog capabilities, pricing and short-list primitives

**Files:** src/lib/model-pricing.ts (new shared pure module), pollinations-model-catalog.ts, text-model-catalog.ts, visual-models.ts, openrouter-image-catalog.ts (new), relevant catalog API routes and tests.
**Interfaces:** Export ModelPrice with currency USD|Pollen, rates and fixed/estimate/unknown display basis, checkedAt/source; export formatModelPrice and comparableModelPrice helpers. TextModelCatalogEntry and PollinationsModel gain optional price metadata. GET /api/settings/visual-provider/models?provider=pollinations|openrouter returns models {id,name,price?,endpoint?,generationSupported}, checkedAt, stale. Definitive OpenRouter eligibility is endpoint input_references.min=0 with raster output. Snapshot endpoint is consumed by Task 1. Coordinate exact types before editing common files.

- [x] Add and observe failing tests for image/MP/token/fees/unknown pricing, edit-only aliases with text+image input, optional references, required references and SVG-only outputs.
- [x] Implement bounded catalogs/caches and public pricing normalization; preserve owner-scoped Pollinations permissions and fresh authorization checks. Bound endpoint discovery to shortlisted/selected models.
- [x] Run focused tests; provide exact interface examples for UI and adapter integration.

### Task 3: Two task settings and shared connections

**Files:** src/components/ai-services-settings.tsx, service-connections.tsx, model-choice.tsx and contextual-help.tsx (new as useful); settings-panel.tsx; existing text/image provider settings; scoped CSS; browser fixtures/scripts.
**Interfaces:** Keep parent onDirtyChange/onSaveReady contracts. Two independent role drafts, three-item shortlist with selected model retained, full search, price and missing connection states. Shared connections use Task 1 endpoint and Task 2 catalog. Help button uses current Dialog; essential cost/payer/errors stay visible.

- [x] Add/run browser regressions for independent choices, shared connections, draft races, search, focus, cancel, help dialog and compact/mobile layout.
- [x] Implement the approved UI using existing styles and expose advanced model/technical controls only on request.
- [x] Verify desktop, 390/320 mobile, keyboard and dialog close/focus; retain existing settings save latency behavior.

### Task 4: Existing UI copy audit

**Files:** account/narrative/developer settings, visual gallery and other current UI identified during audit; exclude files owned by Task 3 until coordinated; docs UI audit report.
**Interfaces:** Reuse contextual-help component when available; technical details may move into existing details or help. Preserve essential limitations, access/privacy warnings, actions and status.

- [x] Inventory user-facing technical load in settings and main flows, recording concrete decisions.
- [x] Simplify redundant copy and use progressive disclosure without altering story semantics; run affected browser/copy checks.

### Task 5: Review, verify and release

**Files:** roadmap, behavior docs, release report/measurement JSON, CI workflow if new checks need coverage.

- [x] Integrate independent work and obtain fresh whole-change review; resolve material findings with reproductions.
- [x] Run full hermetic npm test, typecheck, lint, docs, production build, migrations and relevant native PostgreSQL/browser suites. Inspect every result.
- [x] Commit all completed changes, including the approved proposal and this plan; push, integrate on main and deploy through the existing production path.
- [x] Verify deployed version, guest/account settings, catalogs/help, independent saves and real-DB timings; record exact evidence and paid-generation limitations.
- [x] Update roadmap and release report, commit/push final documentation, ensure root and release working trees contain no omitted completed changes.

## Execution record

Implementation authorized explicitly by the user; continued in the existing isolated worktree on `codex/provider-selection-pricing`. Root implemented UI/integration; GPT-6.1 Sol implementers handled independent backend, catalog and copy domains; a fresh GPT-6.1 Sol reviewer checked the complete change. No additional design approval or integration menu is needed: implementation, push and production release were expressly requested.

Review corrections: current credentials and session rechecked after metadata/lease waits; Live intent preserved on unrelated general writes; resolution state cleared on draft invalidation; application payer displays its actual administrator model; prices match the saved endpoint; community choices excluded from the primary shortlist and labelled in the full catalog; advanced Gemini mutations refresh the shared connection view. RED/green reproductions and test logs are in the ignored `output/provider-selection-release` workspace.

The first pre-integration full run had three failures while files/fixtures were being introduced: missing help module during creation and two legacy expected-row snapshots lacking new columns. These are corrected; that run is not final release evidence. The stable integrated local run and exact-commit CI subsequently passed. Production generation is not used to infer model quality from mock transport tests.

Local release gates: ordinary 1303/1303, final catalog 9/9, native 39/39, provider UI 42, Pollinations 75, draft 24, latency 12, gallery 16, actual Next story/game, full ESLint, production Next build/typecheck and docs104/454 passed. One additional top-level catalog exclusion test was added after the ordinary run had begun; it passed in the final focused run and is included in the exact-commit CI. No paid generation was executed.

Final release: commits 05fc5aa and 16869ab pushed and fast-forwarded to main; exact CI 39288274263 success (1304 unit, 39 native, 22 fresh/replay). Production 7179719284 / build f9cd3222-cf40-42b2-a251-365d8ac335f7 verified with real DB guest/account, independent saves, catalogs/prices, edit-only deny, help/focus, 30 timing points and successful restoration/session revocation/private-state removal. Final documentation and safe measurements: [release report](../../provider-selection-release-2026-10-19.md). Source inventory 534 matches the tested commit; final documentation commit does not change runtime code.
