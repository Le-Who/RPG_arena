## 2024-06-25 - Avoid Array Methods for Simple Edge Keys
**Learning:** In tight loops like graph traversal (`mapEdges`), using `[id1, id2].sort().join("|")` to generate symmetric edge keys creates excessive array allocations and overhead, significantly slowing down calculations on every render of components like `MapCanvas`.
**Action:** Use simple string concatenation with a ternary operator (`id1 < id2 ? id1 + "|" + id2 : id2 + "|" + id1`) for undirected edge key generation to avoid array allocations entirely.
