<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## PostgreSQL extensions

Migration `drizzle/0006_database_memory_search.sql` is immutable and requires pgvector/pgcrypto. When local PostgreSQL lacks pgvector, use the bundled PGlite tests or the pgvector Docker image described in `docs/agent-pgvector-setup.md`. Do not rewrite migration 0006, the Drizzle journal, or readiness checks to bypass a missing local extension.
