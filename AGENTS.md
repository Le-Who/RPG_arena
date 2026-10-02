<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project intent

Chronicle Engine is a universal interactive-story application: everyday life, social scenes, open-ended stories and bounded arcs are first-class uses. Preserve `preset`/`free` campaigns and `d20`/`rules-light`/`narrative` profiles; do not assume every story needs combat, danger or dice. User-facing copy is Russian.

## Working context

Read the code and documentation relevant to the change; a small edit does not require reading every document or replaying the entire development workflow. Resolve routine implementation choices within the requested scope and carry authorized local work through verification. Ask when missing information materially changes the product behavior or an external action lacks authorization.

Discover the current structure from the repository. Find the relevant implementation, its callers and behavior tests by searching symbols, routes and usages. Treat documented paths as starting points, not an exhaustive map. If code and documentation disagree, investigate the intended behavior using tests and change history; do not assume either is automatically correct.

Use `package.json` for current scripts and dependencies, and `docs/superpowers/plans/roadmap.md` for priorities and links to current plans. Verify referenced files still exist; locate moved content when necessary. Reuse the project's current UI conventions and check current provider documentation when changing an API contract.

## Correctness boundaries

- Models propose changes; server rules determine what is committed. Intent, a model verdict and an exact quote are different kinds of evidence. Check claims against the appropriate source and final repaired narration; uncertainty is not permission to invent canon. Deterministic resources, permissions and execution remain in code.
- Preserve admission, request idempotency, lease/fencing and atomic commit of turn, state and jobs. Reducers must not mutate the input snapshot. Keep displayed applied changes and semantic memory consistent with the final accepted state.
- Scope campaign reads, writes, caches and background work to the authorized identity. Public reading does not authorize editing or portable JSON export. Admin status does not bypass ownership. Keep provider keys server-side and out of logs, fixtures and exports.
- New persisted fields need bounded parsing, legacy defaults and compatibility with checkpoints, forks, copies and strict portable JSON. Retain provenance during ID remapping. Extend the allowlist rather than relaxing unknown-field validation.
- Provider errors, usage and fallback behavior must stay explicit. Use existing quota/secret facilities. Live paid evaluations and operations on a real campaign database need authorization for that environment; isolated local tests need no further confirmation.

## PostgreSQL extensions

Migration `drizzle/0006_database_memory_search.sql` is immutable and requires pgvector/pgcrypto. When local PostgreSQL lacks pgvector, use the bundled PGlite tests or the pgvector Docker image described in `docs/agent-pgvector-setup.md`. Do not rewrite migration 0006, the Drizzle journal, or readiness checks to bypass a missing local extension.

Schema evolution is append-only. Preserve historical migrations and their ledger entries; add a migration when persisted SQL structure changes.

## Verification and delivery

Use npm and the existing lockfile. Choose checks proportional to the changed behavior; after a passing run, repeat only checks affected by later changes or unresolved failures.

- Select current verification scripts from `package.json` and inspect their environment setup before narrowing a run. Preserve test isolation: use disposable databases and keep real provider credentials out of local tests.
- Check changed behavior with focused tests; use broader type, lint, integration and build checks when the scope warrants them. Use the repository's documentation checker for documentation changes when available.
- UI changes: inspect relevant desktop/mobile and keyboard states using an isolated server or existing mock fixtures; discover current verification tooling and its environment requirements in the repository.

Treat `revisions/` as candidate snapshots. Compare meaningful changes after line-ending normalization, integrate selectively, and preserve the supplied source. Update behavior documentation and the main roadmap when a feature's status changes; keep existing task IDs. Record accepted, adapted and deferred ideas in a revision review. Report actual checks and limitations: mock/unit success does not establish live model quality or production readiness.

Keep this guide concise and stable. Avoid duplicating module inventories or command lists maintained elsewhere. Put feature contracts and one-off investigation history in `docs/`, link them only where useful, and retain the generated Next.js block above.
