# Turn latency and reliable world state implementation plan

> **For agentic workers:** Use subagent-driven-development for the independent map task and review; implement the tightly coupled turn transport locally. Track evidence here.

**Goal:** Implement all five latency improvements while preserving story quality and durable turn semantics, hide inventory identity from players, restore discoverable map topology, and retry Gemini overload before model fallback.

**Architecture:** Keep JSON clients compatible; opt in to NDJSON turn events (stage, provisional narration, committed result, error). Stream one schema-constrained Gemini generation, validate the complete result and atomically save before emitting commit. Disconnects leave the durable ledger recoverable. Render committed prose immediately, refresh the snapshot in background, and include authoritative committed state so new actions can proceed while bulk panels refresh. Prewarm only exact query vectors, never cache ranked memory results. Hidden item IDs travel as validated metadata and participate in idempotency.

**Constraints:** No removed memory, shorter prose, weakened validation, or premature state application. Retain canonical-memory precedence and transactional outbox. Timing contains no prompts or secrets. No actual provider keys or configured DB are present: exercise provider boundaries with deterministic HTTP mocks and use a local test DB if available. Real-provider performance claims require later measurements.

## Tasks
- [x] 1. Provider: overload retry on same model, alternate keys first, bounded total deadline; streaming SSE reader, attempt resets, complete-body timing. Files: gemini.ts, new provider transport helpers/tests.
- [x] 2. Turn telemetry and transport: phase measurements persisted in context/response, Server-Timing for JSON, NDJSON events and recovered commits. Files: turn.ts, turn-contract.ts, act route, stream helpers/tests.
- [x] 3. Immediate UI: provisional prose, committed prose before refresh, refresh failure/recovery and next-turn gating, client timing. Files: use-turn-request.ts, play-room.tsx, client helpers/browser tests.
- [x] 4. Memory writes: one lock/config read per batch, preserve ordering and provenance, batch embedding queue writes, move independent reads off the serial path. Files: memory.ts, turn.ts, tests.
- [x] 5. Exact choice query prewarming: bounded batched vector cache, shared query construction and query identity, no stale ranked results, initial/reloaded scene warm path, tests.
- [x] 6. Inventory metadata: visible name-only action, hidden exact item IDs, validate session/quantity, bind retries/hash, pin selected item in prompt. Files: turn-contract/admission, act route, play-room, context helpers, tests.
- [x] 7. Map: inspect existing graph renderer and resolution contract; support several discoveries and explicit connections in one turn; preserve unknown visibility, connect actual travel, test graph persistence. Files: resolution.ts, location operation executor/helper, world-map tests and prompt integration.
- [x] 8. Verify: typecheck, full tests, lint, production build, browser flows with deterministic server/provider fixtures, independent code review, document operation and remaining external measurement limits.

## Decisions and evidence
- Ruling: Work on `codex/turn-latency-and-world-state` in the existing checkout; no tracked user modifications exist, `.agents/` is user-owned and untouched. A separate worktree adds no safety for the single checkout writer.
- Ruling: The user's implementation request approves the prior five-point design. No repeated design approval.
- Baseline plain `npm test` fails at DB module import because DATABASE_URL is absent; rerun with a placeholder local test URL (unit tests do not require a real connection).
- Interface scan: provider produces reset/text callbacks consumed by turn; turn emits commit only after transaction, client treats all earlier text as provisional. Map changes resolution and its new executor; root handles turn.ts integration to avoid concurrent edits. Inventory IDs affect request hash but never visible or stored player prose. Prewarm stores only vectors, retrieval ranks current DB candidates. All task tests preserve these constraints.

- Provider, transport, preview, item identity, batched memory and map regressions added. Baseline 117 tests; expanded suite currently 149 passing tests.
- Independent map review found/fixed duplicate-name ID movement, null topology entries, and canonical memory on first reveal of existing hidden locations (10 focused tests).
- Independent turn review found/fixed stalled stream after poll recovery, old initial snapshot replacing recovered state, and key-specific HTTP400 skipping alternate keys. Browser regressions pass, including next-turn streaming while the previous snapshot is delayed and stale inventory gating.
- Isolated PGlite database (PostgreSQL WASM socket) migrated successfully. New turn-latency-smoke passed actual DB persistence with mocked provider, including precommit draft visibility, exact prewarm reuse, fresh ranking, bidirectional map writes, durable replay, hidden item prompt, and asynchronous complete timings.
- PGlite multiplexing was unsuitable for the legacy concurrency smoke. Native PostgreSQL 18.4 passes smoke.ts, v22-smoke.ts and turn-latency-smoke.ts, including six competing actions and lease fencing.
- TypeScript, ESLint, production build, 149 unit tests, story UI browser and turn latency browser checks pass. Operational details: docs/turn-latency-operations.md.
- No real Gemini request made; reported fixture timings are not provider performance measurements.
