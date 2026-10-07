# Coding standards

Read the section matching the work before changing that area. [AGENTS.md](AGENTS.md) provides the project intent and verification guide.

## Turn and state correctness

Models propose changes; server rules determine what is committed. Intent, a model verdict and an exact quote are different kinds of evidence. Check claims against the appropriate source and final repaired narration; uncertainty is not permission to invent canon. Deterministic resources, permissions and execution remain in code.

Preserve admission, request idempotency, lease/fencing and atomic commit of turn, state and jobs. Reducers must not mutate the input snapshot. Keep displayed applied changes and semantic memory consistent with the final accepted state.

## Identity and secrets

Scope campaign reads, writes, caches and background work to the authorized identity. Public reading does not authorize editing or portable JSON export. Admin status does not bypass ownership. Keep provider keys server-side and out of logs, fixtures and exports.

## Persistence compatibility

New persisted fields need bounded parsing, legacy defaults and compatibility with checkpoints, forks, copies and strict portable JSON. Retain provenance during ID remapping. Extend the allowlist rather than relaxing unknown-field validation.

## Providers and authorized environments

Check current provider documentation when changing an API contract. Provider errors, usage and fallback behavior must stay explicit. Use existing quota/secret facilities.

Live paid evaluations and operations on a real campaign database need authorization for that environment; isolated local tests need no further confirmation.

## PostgreSQL and migrations

Schema evolution is append-only. Preserve historical migrations and their ledger entries; add a migration when persisted SQL structure changes.

Migration `drizzle/0006_database_memory_search.sql` is immutable and requires pgvector/pgcrypto. When local PostgreSQL lacks pgvector, use the bundled PGlite tests or the pgvector Docker image described in [agent-pgvector-setup.md](docs/agent-pgvector-setup.md). Do not rewrite migration 0006, the Drizzle journal, or readiness checks to bypass a missing local extension.
