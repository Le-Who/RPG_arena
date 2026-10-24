## 2025-02-12 - [...array].reverse().find()
**Learning:** `[...array].reverse().find()` creates unnecessary allocations and can be an O(N) memory overhead for finding the last matching item, especially for large arrays like `snapshot.turns`.
**Action:** Replace `[...array].reverse().find(cb)` with a custom `findLast` utility that iterates backward without creating a new array.

## 2026-10-07 - Node.js `node:child_process` ESM import error
**Learning:** When evaluating TypeScript code dynamically via `tsx --eval` (e.g. during tests), you should not use `.ts` extension in imports of local modules. `import { openSecret } from './src/lib/secret-vault.ts';` fails with `does not provide an export named 'openSecret'` (actually, it fails because `tsx` may wrap exports inside `default` or because of the `.ts` extension). Wait, the memory states: "named exports from local modules may be wrapped inside a `default` object due to ESM/CommonJS interop (e.g., `(await import('./src/lib/module.ts')).default.exportName`)".
**Action:** Change `import { openSecret } from ...` to dynamic import `(await import('./src/lib/secret-vault.ts')).default.openSecret(...)` or similar inside `tsx --eval`.
