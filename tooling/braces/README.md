# Private braces security patch

This is a private, source-vendored copy of `braces@3.0.3` with a depth-bound patch for [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). It is not an upstream patched release. The upstream MIT license and attribution are retained in `LICENSE`.

The current lockfile has a single transitive braces consumer in this chain:

```text
@next/eslint-plugin-next@16.4.2
  -> fast-glob@3.3.1
    -> micromatch@4.0.8
      -> braces (this private package)
```

The package is a root file dev dependency named `braces`; the root leaf override references `$braces`. This keeps npm's local path anchored at the project root and works with `npm ci --ignore-scripts`. Docker must copy this directory before dependency installation. The ESLint 10 migration replaced the nested override because npm 11 assigned conflicting override ancestry to shared dependencies. The current consumer is unchanged; `tests/eslint-toolchain-compat.test.ts` rejects consumers requiring a different braces API. Review any future expansion of this override's reach explicitly.

## Provenance and patch

`index.js`, `lib/*.js` and `LICENSE` originate from the installed, lockfile-verified [braces 3.0.3 package](https://www.npmjs.com/package/braces/v/3.0.3). `index.js`, `constants.js`, `utils.js` and `LICENSE` are unchanged. `fill-range` remains at the existing locked version `7.1.1`.

The only algorithm changes are:

- Add `lib/depth.js`, with a hard limit of 128 recursive levels and a controlled `SyntaxError` carrying `code: "ERR_BRACES_DEPTH"`.
- Check parser stack depth before adding brace or parenthesis AST blocks. Bracket/quote literals retain their original parsing rules.
- Track and check depth in `compile`, `expand` and `stringify`, including caller-supplied ASTs.

Options cannot disable this bound. Excessive nesting fails explicitly instead of returning a partial root list. Ordinary grammar, numeric-range limits, duplicate filtering, compilation mode and filesystem discovery remain unchanged.

This patch addresses the reported stack-exhaustion vulnerability. It does not claim to redesign or bound every possible brace expansion; the original expansion/range contracts otherwise remain in effect. Application request data does not enter this lint-only dependency.

## Verification and removal

`tests/eslint-braces.test.ts` checks grammar, public API entrypoints and depth boundaries. `tests/eslint-next-glob.test.ts` runs the installed Next helper and actual ESLint rule, including numeric ranges, symlinks/junctions, Windows paths and the original crash pattern. Full audit results and install/build checks are recorded in the repository's ESLint remediation report.

When upgrading Next's ESLint toolchain, first check whether upstream removed or patched the affected chain. Once upstream passes these behavioral regressions and the full audit, remove the root file dependency, braces override, this directory and its Docker COPY together. Keep the [ESLint 10 migration report](../../docs/eslint10-migration-2026-10-18.md) in mind when changing the two root overrides.
