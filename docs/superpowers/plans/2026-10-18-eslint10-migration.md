# ESLint 10 migration — 2026-10-18

Goal: move the development toolchain to supported ESLint 10 while preserving Next 16, the existing React/accessibility/import rules and the bounded braces security patch.

1. Characterize actual lint diagnostics and fixes on JSX and TSX, including React's detected version and JSDoc component recognition. Save the effective ESLint 9 configuration for comparison.
2. Pin ESLint 10.13.0 and the official `@eslint/compat` 2.1.1. Upgrade Next/config/plugin together to 16.4.2 for the upstream Babel scope-manager bridge. Preserve Next's complete flat configuration and wrap it with `fixupConfigRules` for the remaining SourceCode APIs.
3. Preserve all effective rule levels/options, settings and ignores. State the Node.js floor and distinguish the verified compatibility bridge from native upstream plugin support.
4. Verify clean npm installation, the complete dependency tree, development/production audits, focused regression tests, types, lint, build, the full standard test command and documentation links in a physical copy without private environment files or real credentials.
5. Obtain an independent review, address findings, record the evidence and the conditions for removing the bridge.

Do not change application behavior, historical migrations, deployment provider credentials or pre-existing unrelated workspace edits. Do not use `--force` or `--legacy-peer-deps`.

Observed decisions: separate scoped peer overrides conflict on shared hoisted dependencies under npm 11, even with matching semver. Use two root leaf overrides, `eslint: "$eslint"` and `braces: "$braces"`, without disabling npm peer validation. The dependency contract regression checks upstream ESLint peers, allows only the three exact verified legacy plugin versions, rejects an older resolved ESLint and rejects braces consumers requiring a different API. The braces override still reaches the same sole micromatch consumer in the current graph. Raw Next 16.4.2 still fails two autofix fixtures and silently misses the JSDoc class mutation; official compat repairs these cases.
