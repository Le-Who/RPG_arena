## 2024-05-24 - Fast Composite Keys
**Learning:** Using `JSON.stringify` to create composite keys for `Map` lookups or React loops is surprisingly slow (~10x slower than string interpolation) and blocks the main thread in tight loops like `buildNarrativeFeed`.
**Action:** Always prefer template literals (`${a}:${b}:${c}`) over `JSON.stringify([a, b, c])` when generating unique string keys for simple primitive data like IDs and enums.
