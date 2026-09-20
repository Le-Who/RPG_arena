# Database memory search implementation plan

**Goal:** Stop transferring every campaign embedding to the application during retrieval, without sacrificing the existing weighted ranking or campaign isolation.

**Architecture:** Use pgvector exact cosine distance inside PostgreSQL on the existing `real[]` values. Move the complete weighted score and per-layer cap into SQL, returning at most 20 results and a candidate count. Keep the old reader only for databases where migration 0006 has not yet been applied. Existing vectors remain readable immediately: no provider calls, bulk rewrite, duplicate vector storage, or background conversion are required.

**Scope:** First scaling stage approved in the conversation. Approximate indexes and memory retention changes require measured justification and are not enabled in this change. Production deployment is separate from local implementation.

**Constraints:** Preserve session/model/dimension/status/content-hash filters, current importance/age/salience/provenance weights, and layer diversity. Reject invalid vectors. Support 768/1536/3072, including existing records. SQL calls have a remaining-budget statement timeout and release pooled connections. No API keys in tests; never benchmark against a production database.

## Tasks

- [x] Add migration 0006: enable vector and pgcrypto, safe conversion and exact JavaScript-compatible embedding content hash. Test old arrays, malformed vectors, Unicode and stale content in isolated PGlite PostgreSQL.
- [x] Add parameterized SQL retrieval in `src/lib/memory-search.ts`, preserving weighted rank and layer caps. Compare results against the existing JS algorithm at all supported dimensions; test cross-campaign, model, dimension, pending and stale exclusions, empty results and result size.
- [x] Integrate into `searchMemory`: capability detection for rolling deployment, bounded DB operations, existing query cache, and stage timings. Keep legacy fallback only for missing migration, not arbitrary query failures.
- [x] Add a reproducible synthetic benchmark for 100/1,000/10,000/50,000 nodes at all supported dimensions. Record timings, returned bytes and parity; label local PostgreSQL/WASM timings separately from Vercel/Neon latency.
- [x] Run unit/integration suite, typecheck, lint and production build; request independent review. Document deployment, rollback, benchmark results and remaining O(N) database computation.

## Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build` with a dummy DATABASE_URL for tests that import the DB module. The PostgreSQL integration tests instantiate PGlite with vector/pgcrypto in memory, so they never connect to a deployed database. Benchmark commands and measured outcomes belong in `docs/database-memory-search.md`.

## Outcome

173 tests passed, including real PostgreSQL/pgvector integration and migration-ledger replay. TypeScript, ESLint and production build passed. All 12 synthetic benchmark combinations matched reference rankings. Independent review found no blockers; the inherited telemetry deadline limitation is documented. No production migration, deployment, provider request or campaign data change was performed.
