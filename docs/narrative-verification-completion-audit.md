# Implementation audit — selective narrative verification

Historical audit of the initial opt-in implementation. The user's subsequent default-on, administrator-key fallback, outage bypass and asynchronous diagnostics decisions supersede its operational policy. Current release behavior and outstanding work: [release guide](narrative-verification-release.md).

This audit concerns the opt-in feature on `codex/selective-narrative-verification`. Deployment, publishing the branch and correcting the already-played campaign are separate actions. The historical campaign has not been rewritten.

| Requirement | Implementation and inspected evidence | Scope of proof |
| --- | --- | --- |
| Explain and address the cause of invented contracts and prose/state divergence | Research report; server resolves mechanics once; `narrative-guard.ts`, `turn.ts`; original-turn evidence and immutable agreement journal | Evidence authority and publication order are enforced; models can still make semantic mistakes |
| Ask relevant typed questions only when necessary | `narrative-policy.ts`; seven routing tests; per-attempt selection audit; empty scopes omitted only when structurally known | Ordinary descriptions skip remote verification; lexical/declaration routing is fallible |
| Jev through the user's OpenRouter key | `narrative-verifier.ts`; transport/provider/redirect/error tests; local live reports | Separate owner settings, no production environment-key borrowing |
| Preserve low latency where possible | Metadata-first parser; complete-sentence preview; one batched verification per draft; bounded optional review and one repair | Critical text waits for approval; already emitted prefixes cannot be rewritten |
| Never publish invalid, expired or unavailable critical results | Guard and real `performTurn` tests: missing key, unavailable, malformed, duplicates, late escalation, expired lease, replay | Atomic commit and no dice reroll/state reapplication |
| Keep inventory and narration consistent | Pants integration; independent candidate tests; same-turn add/equip/stack/remove/reacquire tests | Independent gains need their own evidence even on a failed roll |
| Preserve historical terms and distinguish claims from facts | Agreement parser/reducer/SQL triggers; source hash binding; owner/time scope; intention, legacy/disputed prose, future-source and review-citation regressions | Missing evidence stays unknown; journal revisions preserve original terms |
| Keep evidence across lifecycle operations | Actual PGlite checkpoint/fork/public-copy tests, markdown export tests | Source identities remapped without changing original text/hash; isolated ownership |
| Retrieve original events beyond summaries at scale | Actual SQL fixtures at 100/1,000/10,000 turns, lexical and direct-reference paths, foreign/future exclusions; migration backfill/update tests | Target-source recall 1/1 per path and corpus; not a population-level recall benchmark |
| Prevent rejected text from becoming future context/memory | Twenty consecutive authored story turns through `performTurn`: create/amend/fulfill agreement, reject and repair district claim on turn 11; inspect all saved narrations, subsequent prompts, journal, chapter memory and semantic-job payloads | Deterministic provider responses test propagation plumbing; asynchronous extraction model quality is not inferred from these assertions |
| Live semantic evaluation and repair | 28-case integrated guard report; five actual serialized-state cases; latest live pants repair using both verifier and optional reviewer | Authored synthetic examples, no private campaign data and no universal correctness guarantee |
| Owner-facing configuration and checking status | Settings tests and mocked browser desktop/mobile screenshots under `output/playwright`; disabled by default; Gemini escalation quota/latency disclosed | Visual state/layout inspected; parser and committed-feed tests cover publication order |
| Deployment migration behavior | Full-journal apply/replay/future-entry/rollback tests; migration 0009 included | No production migration run; stored-column backfill takes a table lock and needs deployment time |

## Measured results

The 28-case integrated live report `output/narrative-evaluation/pipeline-2026-09-20T18-36-02-270Z.json` allowed 12/12 consistent drafts and blocked 10/10 contradictions plus 6/6 insufficient-evidence drafts. Eight cases invoked the reviewer; fourteen requested repair, deliberately disabled in this admission-only experiment. One invalid Jev response stopped safely. This corpus was already consumed during development and is not a fresh holdout for the final policy.

Complete guard latency in that batch was p50 454 ms and p95 3,167 ms (nearest rank). Repair requests were 14/28; this is an intentionally balanced error-heavy corpus, not an estimate of real-player repair frequency.

The latest live pants experiment (`output/narrative-evaluation/repair.json`) completed one repair in 4,246 ms: first Jev rejection 826 ms, Gemini correction 983 ms, second Jev uncertainty 490 ms, then a successful optional review. This measures a single synthetic run, not p95 or ordinary full-turn latency. No rule accepts raw uncertainty without review approval.

The 10,000-turn local PGlite queries decreased from 6.3–8.9 seconds to 33–194 ms with stored vectors and indexed candidate retrieval. The same source and isolation assertions passed before and after. Production latency and migration backfill duration are not inferred from this local fixture.

## Remaining operational boundaries

Final verification: all 267 repository tests passed, TypeScript and ESLint passed, and the production build passed. Tests/build used an unreachable dummy database URL; no production database operation was needed. Independent pipeline and uncertainty-review findings were addressed before this final audit; the latest scale and sequential-history regressions cover the subsequent changes.

- Verification is opt-in. The legacy disabled path does not receive this protection.
- The unchecked descriptive path and semantic verifiers remain fallible. No claim of eliminating every hallucination is made.
- Bounded evidence can miss a source; absence is not treated as evidence of the opposite. More diverse retrieval/model evaluation is future calibration, not proof supplied by synthetic successes.
- Existing disputed turns require the campaign owner's canon decision and an explicit repair operation. No automatic inventory grant, historical dice rewrite or district-contract correction was performed.
- No feature commit, push or deployment has been performed. User roadmap documents and `.agents/` remain untouched by this feature's integration workflow.
