# Coding standards

## Work and verification

Use npm and the existing lockfile. Take current scripts and dependencies from `package.json`. Resolve code/documentation disagreements using tests and change history.

Before narrowing a verification run, inspect its environment setup. Use disposable databases and keep real provider credentials out of local tests.

Choose checks proportional to changed behavior: focused tests, adding broader type, lint, integration and build checks when warranted. After a passing run, repeat only checks affected by later changes or unresolved failures. For reviews without edits, record inspected evidence and gaps.

Report actual checks and limitations: mock/unit success does not establish live model quality or production readiness.

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

## UI changes

Reuse the project's current UI conventions. Inspect relevant desktop/mobile and keyboard states using an isolated server or existing mock fixtures and the repository's current verification tooling.

## Documentation and revisions

For documentation changes, run the repository's documentation checker. For root instruction edits, check local links and heading anchors separately: the checker scans only `README.md` and `docs/` and skips anchors. Put feature contracts and one-off investigation history in `docs/`. When editing agent instructions, retain the generated Next.js block and avoid duplicating module inventories or command lists maintained elsewhere.

For feature planning, use the [roadmap](docs/superpowers/plans/roadmap.md) for priorities and current plans. When a feature's status changes, update behavior documentation and the main roadmap; keep existing task IDs.

Treat `revisions/` as candidate snapshots. Compare meaningful changes after line-ending normalization, integrate selectively, and preserve the supplied source. Record accepted, adapted and deferred ideas in a revision review.
