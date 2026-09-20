# Database memory retrieval

## Behavior

Migration `0006_database_memory_search` enables `vector` (pgvector) and `pgcrypto` and installs two immutable helpers. The application performs exact cosine search over existing `memory_embeddings.vector real[]` values in PostgreSQL. No bulk rewrite, re-embedding, new credentials, duplicated vector column or background backfill is needed. Existing application and worker versions can still read/write those arrays.

SQL preserves campaign, model, dimension, ready-status and current-content-hash checks. Both sides of the memory/embedding join must belong to the requested campaign. Invalid, empty, zero, non-finite, wrongly sized and multidimensional vectors are excluded. Embedding hashes reproduce the existing JS document formatting, including UTF-16 truncation. Query vectors and other inputs are bound parameters.

The score remains `similarity * .55 + importance / 100 * .2 + freshness * .1 + salience / 100 * .05 + provenance * .1`. The similarity threshold is applied before ranking; layer limits are applied after the weighted ranking, before the final result limit. UUID is now the deterministic tie-breaker for equal scores (the old query did not guarantee ties). Only up to 20 selected nodes, their scores and the matching candidate count leave the database. The game requests 8.

This is exact search, not an approximate nearest-neighbor index. Database scanning and hash verification remain O(N * dimensions); sorting is also required. HNSW would change candidate recall and must be evaluated separately against the weighted ranking and campaign filtering. Its index dimension limits also differ from the dimensions supported by exact vector operations; do not assume a standard 3072-dimensional vector HNSW index is supported.

The existing memory writer already updates canonical facts and suppresses identical content. This change does not delete history or change retention rules.

## Deployment and rollback

1. Use the normal database backup procedure before running deployment migrations.
2. Verify the database provides pgvector and pgcrypto. Neon supports pgvector; the deployment role must be able to enable extensions. On self-hosted PostgreSQL, install the extension files first.
3. Vercel uses the repository's `vercel.json` build command: `npm run build:deploy`, which runs pending migrations before `next build`. Set `DATABASE_URL` in the target Vercel environment; no `.env` file is required. Production must point to production; Preview must use its own database/Neon branch. Every deployment build migrates the database in its environment. Do not give unreviewed preview branches production database credentials.
4. The runner holds a transaction advisory lock before reading the existing Drizzle ledger, applies pending SQL and ledger entries atomically, and skips already applied entries. This works with Neon transaction pooling. A failed migration/lock timeout stops the build and rolls back that migration transaction. A later Next build failure does not undo successful migrations: keep migrations compatible with the currently running version. Manual/non-Vercel deployments must use `npm run build:deploy` or run `npm run migrate` first. Plain `npm run build` remains a local compilation check. Capability detection retains the legacy reader if someone deploys without the migration.
5. Confirm `retrievalBackend: "postgres"` in a new turn's timings, or `backend: "postgres"` in the owner-only memory-search API response.

SQL errors and timeouts do not trigger an expensive legacy retry. During gameplay the existing retrieval error handler records a warning and allows generation with the other context. An explicit search API request returns its normal search error. A database containing only stale/invalid embeddings does not invoke Gemini for retrieval.

Rollback by deploying the previous application version; leave migration 0006 installed. No data rollback or vector conversion is needed. Do not drop the helpers while the new version is serving queries.

Future migrations must include both the SQL file and an appended entry in `drizzle/meta/_journal.json`, with a strictly increasing timestamp. Existing entries/SQL are immutable once deployed. The runner retains Drizzle's timestamp-based ledger semantics; unregistered SQL files are not discovered. Migration SQL must support transactions (for example, use a separate operational procedure for `CREATE INDEX CONCURRENTLY`). Use the runner for every deployment; external migration tools that do not acquire its advisory lock must not run concurrently. Check build logs for `Chronicle migrations complete: N applied, M already recorded.`

## Timing and diagnostics

Turn timings now include `retrievalBackend`, `retrievalCandidates`, `retrievalDatabaseMs`, and `retrievalEmbeddingMs`, in addition to total `retrievalMs`. The database measurement includes pool acquisition, capability/readiness checks and retrieval transactions. The embedding measurement includes the query-vector cache and, on a cache miss, the provider request and its telemetry. The search API exposes analogous `backend`, `databaseMs` and `embeddingMs` fields. The legacy backend reports the two sub-durations as null because it does not separate them.

Each retrieval database operation uses the remaining time budget for pool acquisition, transaction-local `statement_timeout`, and the client query timeout. Failed/timed-out connections are destroyed; successful connections return without persistent session settings. These are DB-operation deadlines, not a guarantee for the entire turn: existing provider telemetry and other generation/context work have their own behavior. Gameplay currently allocates a 6-second retrieval budget.

## Reproducible local benchmark

Run `node --import tsx scripts/benchmark-memory-search.ts`. It uses disposable in-memory PGlite PostgreSQL with real pgvector/pgcrypto, never `DATABASE_URL`, and never Gemini. Optional `MEMORY_BENCH_SIZES=100,1000` and `MEMORY_BENCH_DIMS=768,3072` select subsets.

The fixture uses 32 deterministic dense vector prototypes, varied scores/ages/sources and four layers. After one warmup, it reports median query duration over three runs, serialized result bytes, the lower bound on old vector bytes, and parity against the JS scoring reference. This validates weighted retrieval parity, not real-world semantic recall of the embedding model.

Measured locally on 2026-09-20, PostgreSQL compiled to WASM; **these are not Neon/Vercel latency estimates**. The timing covers the SQL retrieval query, excluding readiness probes, pool/network overhead and Gemini.

| Memory nodes | 768 dimensions | 1536 dimensions | 3072 dimensions |
| ---: | ---: | ---: | ---: |
| 100 | 9 ms | 10 ms | 14 ms |
| 1,000 | 46 ms | 64 ms | 100 ms |
| 10,000 | 414 ms | 567 ms | 999 ms |
| 50,000 | 2,272 ms | 3,271 ms | 5,511 ms |

Every case returned the same top 8 IDs as the JS reference. Responses were 2,393–2,462 bytes for the short synthetic facts. At 50,000 × 3072 the old vectors alone contain 614,400,000 bytes of float32 values, before array encoding and node text. Real response size depends on selected fact lengths, but is bounded by result count rather than campaign size.

These measurements demonstrate removal of unbounded vector transfer, not that exact search solves arbitrarily large campaigns. At tens of thousands of facts, measure native Neon query plans, concurrent load and p95 retrieval time before deciding between stored vector representations, candidate indexes or partitioning. Provider keys are needed only for a separate real-text semantic-quality evaluation, not this benchmark.

## Tests

`npm test` includes isolated PostgreSQL tests at 768/1536/3072, weighted relevance beating raw similarity, layer diversity, cross-campaign/model/dimension exclusion, stale hashes, invalid arrays, Unicode, empty results, full migration replay, legacy/new reader switching, no fallback after SQL failure, and connection deadline cleanup. No production database is contacted.

References: [pgvector exact search and indexing](https://github.com/pgvector/pgvector), [PGlite extensions](https://pglite.dev/extensions/).
