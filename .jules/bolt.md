## 2026-09-23 - Memoize Long PlayRoom Feed

**Learning:** Re-typing inputs caused major performance lag because the long historical narrative feed in `PlayRoom` (`<article>` list mapping over `turns`) was recalculated and virtually re-rendered on every keystroke (`action` state).
**Action:** Use `useMemo` for both the data array processing (`buildNarrativeFeed`) and the `turns.map()` virtual DOM node generation, factoring out unstable dependencies like `snapshot` directly by reading values (e.g. `characterName`) inside the memo hook instead.
