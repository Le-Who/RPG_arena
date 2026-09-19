# Revision Integration Design

## Goal

Integrate the useful work from `accessibility-revision` and `backend-revision`
into the current Chronicle Engine without regressing the current WebP artwork or
the offline engine used by preset campaigns.

## Source selection

The two revisions share the same v2.2-v2.4 foundation. Use
`accessibility-revision` as the source for that common foundation because it
preserves the existing `preset` offline contract and contains the later reading
preferences, payload reductions, accessibility behavior, and additive v2.5
migration.

Selectively take these additions from `backend-revision`:

- the `WorldMap` component and `world-graph` projection/edge helpers;
- its corresponding minimap and expanded-map styles;
- first-turn onboarding;
- explicit image dimensions and lazy-loading hints where they prevent layout
  shifts.

Do not take these backend-revision decisions:

- removal of `src/lib/engine.ts` or the preset offline fallback;
- the global AI-only campaign behavior;
- restoration of dead schema fields or other changes that conflict with the
  accessibility revision's validated cleanup;
- the model-chain timeout slicing, which is not required by this integration
  and changes provider-fallback semantics.

## Backend and data model

Adopt the v2.2 request-admission protocol, durable memory jobs, checkpoints,
forks, bounded compaction, system diagnostics, streamed JSON size limits, and
strict input validation from `accessibility-revision`.

Database changes remain migration-driven. Migration `0002` adds branch, request,
job, checkpoint, and heartbeat structures. Migration `0003` only adds reading
preferences. Its source revision's `DROP COLUMN` and character-JSON cleanup
statements are deliberately omitted: application code may stop depending on
unused fields, but this integration does not irreversibly erase existing schema
or user data. Existing migrations are never rewritten.

Preset campaigns continue to use the deterministic offline engine when Gemini
is unavailable. Free campaigns continue to return `AI_REQUIRED` without fake
narration.

## Interface and accessibility

Replace the legacy CSS layer with the v2.4 tokenized design system from
`accessibility-revision`: `globals.css`, `shell.css`, `pages.css`, and
`theatre.css`. Keep the reading-preference layer for text scale, measure,
midnight/sepia/high-contrast themes, and reduced motion.

All ordinary interface text uses the system type scale with a 12 px minimum,
AA-oriented color tokens, visible focus, reduced-motion behavior, skip
navigation, keyboard tab behavior, and live status announcements.

The world map is the explicit exception requested by the user: preserve the
backend revision's compact visual design, including its internal numeric
markers. Its location names remain ordinary readable HTML text, while SVG is
used for geometry. Undiscovered locations and dangling edges are excluded.

Keep the current root-level WebP artwork and update all imported revision paths
to those files. Do not copy the revisions' missing `/images/*.jpg` references or
delete current artwork.

## Verification

Required evidence before completion:

- original and added unit tests pass, including offline preset behavior,
  request/checkpoint invariants, reading preferences, and map graph behavior;
- TypeScript checks only the application, not the two local source revisions;
- ESLint and a production Next.js build pass;
- migration ledger validation passes when a test PostgreSQL database is
  available;
- UI audit/browser checks run when their database and browser prerequisites are
  available; otherwise the missing prerequisite is reported explicitly rather
  than represented as a passing check;
- static searches confirm no application artwork references point to missing
  `/images/*.jpg` assets and no ordinary UI font size falls below the design
  floor.
