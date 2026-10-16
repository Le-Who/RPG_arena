# P2 state and resource test coverage

> **For agentic workers:** Execute independent tasks with `dispatching-parallel-agents`; the coordinator owns review, full verification and delivery. Track completion below.

**Goal:** Close the highest remaining deterministic state gaps in coverage matrix domains 3, 5 and 6, fixing only reproduced defects.

**Architecture:** Exercise real reducers and actual turn consumers where persistence matters. Use literal, hand-checked expectations, immutable input snapshots and disposable PGlite with synthetic provider transport. Existing correct behavior receives coverage without a production rewrite.

**Tech Stack:** npm, node:test, tsx, PGlite, Drizzle, Next.js 16.3.8.

**Spec:** [Coverage matrix](../../testing/coverage-matrix-2026-10-09.md), domains 3/5/6; [coding standards](../../../CODING_STANDARDS.md).

## Global constraints

- Work in the attached `p2-state-test-coverage` worktree, seeded with the current main changes from the previous P2 stage. Preserve those preimages.
- Use gpt-6.1-sol: medium reasoning for arithmetic, high for transfers/intent and conditions/timers, high for independent review.
- No real database, inherited credentials, paid provider calls, dependency changes, commit or push. Use the safe test preload.
- Preserve preset/free and d20/rules-light/narrative, Russian product copy and immutable migrations.
- Run existing focused baselines, then new tests against original production code. Investigate failures before a minimal fix; distinguish genuine defects from fixture corrections and mutation controls.
- Agents own disjoint files. Coordinate any shared `turn.ts` change through the coordinator. Mutation controls, if needed, run sequentially after source freeze and restore original bytes.

## Review focus

- HP saturation, level changes and rewards have literal expectations independent of production formulas.
- A failed check cannot grant successful rewards; optional checks and narrative play retain their contracts.
- Intend/ask/claim cannot consume the last item or invent a committed transfer; any proposed commitment follows existing semantics.
- Duplicate transfer references and a give/return cycle preserve quantities, identity, provenance and caller snapshots.
- Same-name medicine must be resolved by identity/kind; refreshed timers have one valid expiry, and malformed maps are bounded.

### Task 1 — resource arithmetic

**Owned:** `tests/resource-arithmetic-p2.test.ts`; minimal fixes in `src/lib/engine.ts`, `dice.ts` or `resolution.ts` only after a genuine failing regression.

- [x] Run existing resolution/action-risk/profile baseline with safe preload (20/20).
- [x] Add literal HP zero/cap, XP threshold, dcFor saturation and risk 60/70 boundaries; exercise successful/failed rewards through real consumers (34 new registrations).
- [x] Verify new cases, input immutability and focused siblings (54/54); no arithmetic defect. Independent task review passed.

### Task 2 — transfers and intent

**Owned:** `tests/transfer-intent-p2.test.ts`; minimal fixes in `src/lib/world-life.ts` only after a genuine regression. Shared turn changes require coordination.

- [x] Run existing world-life/inventory-turn baseline (26/26).
- [x] Cover intend/ask/claim with a last-item transfer proposal through real turn consumption; assert literal inventory, holdings, commitments and persisted evidence. Genuine claim regression fixed by requiring act.
- [x] Cover duplicate references and give/return lifecycle with quantity/provenance and immutable inputs, respecting the supported acquisition contract.
- [x] Verify new cases and affected siblings (66/66, including 8 new registrations); no new return protocol.

### Task 3 — conditions, medicine and timers

**Owned:** `tests/condition-timers-p2.test.ts`; minimal fixes in `src/lib/conditions.ts` only after a genuine regression. Shared turn changes require coordination.

- [x] Run existing conditions-verification baseline (11/11).
- [x] Cover same-name consumables with different kind, valid/invalid patient evidence, refreshed timer exact expiry and bounded malformed timer maps.
- [x] Include real turn/persistence cases proving medicine identity/consumption and final state agreement. Add only transient consumedItems to ApplyResult.
- [x] Verify new cases and affected siblings (16 new registrations, focused 74/74); limited Russian heuristics do not establish model quality.

### Task 4 — independent review and delivery

**Owned:** shared documentation and coverage inventory; coordinator only.

- [x] Inspect all changes, obtain independent spec and quality review, resolve actionable findings (96/96, PASS).
- [x] Freeze production source; run consolidated ordinary coverage (911/911), typecheck, lint and documentation checker. Isolated default Turbopack build passed on equal physical snapshot. Five type-only fixture assertions have identical transpiled output.
- [x] Update matrix, inventory, roadmap and a dated report with actual counts, commands, limitations and next priorities.
- [x] Transfer only this stage's 14 deltas after verifying 558 main preimages; fresh main58/58/typecheck/lint passed. All437 source files match meaningfully (102 CRLF/LF differences; 99 code transpiles byte-identically). Retain logs under `output/p2-state-coverage/`.
