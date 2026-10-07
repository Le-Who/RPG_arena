<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project intent

Chronicle Engine is a universal interactive-story application: everyday life, social scenes, open-ended stories and bounded arcs are first-class uses. Preserve `preset`/`free` campaigns and `d20`/`rules-light`/`narrative` profiles; do not assume every story needs combat, danger or dice. User-facing copy is Russian.

## Working context

Use `package.json` for current scripts and dependencies and the [roadmap](docs/superpowers/plans/roadmap.md) for priorities and current plans. Resolve code/documentation disagreements using tests and change history.

Read each matching section before changes:

- [Turns and state](CODING_STANDARDS.md#turn-and-state-correctness): turn processing, reducers, narration, applied changes or semantic memory.
- [Identity and secrets](CODING_STANDARDS.md#identity-and-secrets): campaign access, caches, background work, portable export or provider keys.
- [Persistence](CODING_STANDARDS.md#persistence-compatibility): persisted fields, checkpoints, forks, copies or ID remapping.
- [Providers and environments](CODING_STANDARDS.md#providers-and-authorized-environments): provider integration, quotas, evaluations or real campaign database operations.
- [PostgreSQL](CODING_STANDARDS.md#postgresql-and-migrations): SQL schema, migrations, readiness or local database setup.
- [UI](CODING_STANDARDS.md#ui-changes): interfaces or user-facing copy.
- [Documentation and revisions](CODING_STANDARDS.md#documentation-and-revisions): documentation, feature status or candidate snapshots.

## Verification

Use npm and the existing lockfile. Choose checks proportional to changed behavior; after a passing run, repeat only checks affected by later changes or unresolved failures. For every change, follow [Verification](CODING_STANDARDS.md#verification).
