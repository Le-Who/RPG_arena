<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project intent

Chronicle Engine is a universal interactive-story application: everyday life, social scenes, open-ended stories and bounded arcs are first-class uses. Preserve `preset`/`free` campaigns and `d20`/`rules-light`/`narrative` profiles; combat, danger and dice are optional. User-facing copy is Russian.

## Task routing

For every task, including reviews and documentation, read [Work and verification](CODING_STANDARDS.md#work-and-verification). Read every matching section before reviewing, editing or running operations:

- [Turns and state](CODING_STANDARDS.md#turn-and-state-correctness): turns, narration, state, reducers, applied changes or semantic memory.
- [Identity and secrets](CODING_STANDARDS.md#identity-and-secrets): campaign access, caches, background work, exports or provider keys.
- [Persistence](CODING_STANDARDS.md#persistence-compatibility): persisted fields, checkpoints, forks, copies, import/export or ID remapping.
- [Providers](CODING_STANDARDS.md#providers-and-authorized-environments): integration, contracts, quotas, evaluations or real campaign database operations.
- [PostgreSQL](CODING_STANDARDS.md#postgresql-and-migrations): SQL, migrations, readiness or database setup.
- [UI](CODING_STANDARDS.md#ui-changes): interfaces or user-facing copy.
- [Documentation and revisions](CODING_STANDARDS.md#documentation-and-revisions): documentation, feature planning/status or revision snapshots.
