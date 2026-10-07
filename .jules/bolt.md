## 2025-02-12 - [...array].reverse().find()
**Learning:** `[...array].reverse().find()` creates unnecessary allocations and can be an O(N) memory overhead for finding the last matching item, especially for large arrays like `snapshot.turns`.
**Action:** Replace `[...array].reverse().find(cb)` with a custom `findLast` utility that iterates backward without creating a new array.
