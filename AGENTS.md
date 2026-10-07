<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project intent

Chronicle Engine is a universal interactive-story application: everyday life, social scenes, open-ended stories and bounded arcs are first-class uses. Preserve `preset`/`free` campaigns and `d20`/`rules-light`/`narrative` profiles; do not assume every story needs combat, danger or dice. User-facing copy is Russian.

## Working context

Use `package.json` for current scripts and dependencies, and the [roadmap](docs/superpowers/plans/roadmap.md) for priorities and links to current plans. If code and documentation disagree, investigate intended behavior using tests and change history. Reuse the project's current UI conventions.

Before changing an area below, read its rules in [CODING_STANDARDS.md](CODING_STANDARDS.md):

- Turn processing, reducers, narration or semantic memory: [Turn and state correctness](CODING_STANDARDS.md#turn-and-state-correctness).
- Campaign access, caches, background work or portable export: [Identity and secrets](CODING_STANDARDS.md#identity-and-secrets).
- Persisted fields, checkpoints, forks, copies or ID remapping: [Persistence compatibility](CODING_STANDARDS.md#persistence-compatibility).
- Provider integration, quotas, evaluations or real campaign database operations: [Providers and authorized environments](CODING_STANDARDS.md#providers-and-authorized-environments).
- SQL schema, migrations or local PostgreSQL setup: [PostgreSQL and migrations](CODING_STANDARDS.md#postgresql-and-migrations).

## Verification and delivery

Use npm and the existing lockfile. Select checks from `package.json` and inspect their environment setup before narrowing a run. Use disposable databases and keep real provider credentials out of local tests. After a passing run, repeat only checks affected by later changes or unresolved failures.

Check changed behavior with focused tests; use broader type, lint, integration and build checks when the scope warrants them. Run the repository's documentation checker for documentation changes. For UI changes, inspect relevant desktop/mobile and keyboard states using an isolated server or existing mock fixtures and the repository's current verification tooling.

Treat `revisions/` as candidate snapshots. Compare meaningful changes after line-ending normalization, integrate selectively, and preserve the supplied source. Record accepted, adapted and deferred ideas in a revision review.

Update behavior documentation and the main roadmap when a feature's status changes; keep existing task IDs. Put feature contracts and one-off investigation history in `docs/`. Report actual checks and limitations: mock/unit success does not establish live model quality or production readiness.
