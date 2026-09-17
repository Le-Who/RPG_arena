# SDD ledger — plan: docs/superpowers/plans/2026-09-17-audit-findings.md

MERGE_BASE: 40640f675b83ab1e2cad4a56c8a4816c6d529d73
Branch: fix/audit-findings-2026-09-17

## Pre-flight scan

| Task pair / Task | Interface check | Finding |
|---|---|---|
| T1 alone | schema.ts gameTurns/memoryNodes/etc — columns unchanged, index() added | Clean |
| T2 alone | page.tsx busyRef/compactingRef already declared | Clean |
| T3 alone | act/route.ts adds sql import | Clean |
| T4 alone | gemini.ts opts extend, act/route.ts imports RESOLUTION_RESPONSE_SCHEMA | Clean |
| T5 depends on T4 | T4 changes JSON parse block; T5 replaces post-AI dice with preRolledDice in same block | Need to apply T5 patch to T4-modified code |
| T3 + T5 share act/route.ts | T3 changes import line 4; T5 changes import line 18 (engine) and 18 (dice) | No conflict — different import lines |
| T4 + T5 share gemini.ts | T4 adds responseSchema to callGemini opts + schema const; T5 rewrites buildResolutionSystemPrompt | No conflict — different functions |

Ruling: T5 must be applied after T4. In T5 Step 6, the target lines are from T4's version (with `let jsonStr = res.text.trim()`). Implementer must read the file state as left by T4. Ledger note: if T5 implementer finds T4 changes already applied, that is expected — proceed.

## Tasks

- [x] Task 1: DB Indexes Migration — commit 9da4022 (tsc clean)
- [x] Task 2: Double-Click Guard via Ref — commit 18fab3b (tsc clean)
- [x] Task 3: Memory Recency — Weighted ORDER BY — commit 685d103 (tsc clean)
- [x] Task 4: responseSchema + JSON Parse Hardening — commit 2f0f740 (tsc clean)
- [x] Task 5: Dice Before AI (Resolution Refactor) — commit e982d05 (tsc clean, type fix applied)

Task 1: complete (commits 9da4022, tsc 0 errors)
Task 2: complete (commits 18fab3b, tsc 0 errors)
Task 3: complete (commits 685d103, tsc 0 errors)
Task 4: complete (commits 2f0f740, tsc 0 errors)
Task 5: complete (commits e982d05, fix round: initial type annotation error on preRolledDice fixed inline, tsc 0 errors)

Ruling: T5 preRolledDice used explicit inline type `{ d20: number; ... } | null` instead of `typeof dice` (which inferred `null` at declaration time). Cost if wrong: none — type is identical to CheckResult, just inlined.

Branch: fix/audit-findings-2026-09-17
MERGE_BASE: 40640f675b83ab1e2cad4a56c8a4816c6d529d73
All commits: 40640f6..e982d05

