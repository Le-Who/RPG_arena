# Synthetic narrative verification evaluation — 2026-09-20

The current verifier rejects the eight labelled contradictions in this small Russian corpus, but abstains on **9 of 10 valid guarded drafts**. This is an integration/usability blocker for a guard that publishes only verified prose. Zero false accepts in this run does not establish readiness. No thresholds or production code were changed by this evaluation.

## Reproduction and isolation

```
node --import tsx --test tests/narrative-evaluation.test.ts
node --env-file-if-exists=.env --import tsx scripts/eval-narrative-verification.ts
node --env-file-if-exists=.env --import tsx scripts/eval-narrative-verification.ts --live --limit=1
node --env-file-if-exists=.env --import tsx scripts/eval-narrative-verification.ts --live
```

The default is a dry run. Live mode reads `OPENROUTER_API_KEY` from the process environment; Node's env-file option supplies the ignored local `.env`. The script neither prints nor stores credentials. It imports the existing selection policy and verifier directly. There are no database imports, private campaign fixtures or production mutations. Twenty-four hand-labelled synthetic Russian cases live in `scripts/narrative-evaluation-fixtures.ts`.

Requests use the official [OpenRouter Decisions endpoint](https://github.com/OpenRouterTeam/ai-sdk-provider#evaluation-jev-with-ai-sdk-through-openrouter), `https://openrouter.ai/api/alpha/decisions`, requested model `typesafe/jev-1.13`. The run observed `typesafe/jev-1.13-20260917`. The existing parser accepted dated model names, numeric confidence and object probability distributions without changes. This alpha endpoint may change independently of the chat API.

One initial request rejected failed pants acquisition in 777 ms. A subsequent complete batch made 22 sequential network calls with 1,200 ms pacing, a 5,000 ms timeout and zero retries. Two descriptive cases skipped the provider. **Total actual calls: 23.** The initial duplicate is excluded from batch metrics. The harness stops on authentication/payment/quota HTTP errors and invalid response protocol; `--limit` is constrained to 1–30 scenarios. No further live requests were made for calibration.

Only labelled fixture IDs, selection reasons, verdicts, confidence/probabilities, timing, usage and allowlisted protocol metadata are written under ignored `output/narrative-evaluation/`. No state, request body, response body, source text or authorization headers are persisted. Local batch evidence: `output/narrative-evaluation/run-2026-09-20T17-09-40-635Z.json`; initial evidence: `output/narrative-evaluation/run-2026-09-20T17-08-55-348Z.json`.

## Results

| Label | Cases | Verified | Rejected | Uncertain | Policy skip | Unavailable |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Consistent, guarded | 10 | 1 | 0 | 9 | 0 | 0 |
| Contradicts | 8 | 0 | 8 | 0 | 0 | 0 |
| Insufficient evidence | 4 | 0 | 0 | 4 | 0 | 0 |
| Safe description | 2 | 0 | 0 | 0 | 2 | 0 |
| Total | 24 | 1 | 8 | 13 | 2 | 0 |

- Unsafe acceptance: 0/12 non-consistent cases. Explicit false rejection: 0/10 guarded valid cases. Valid-case abstention: **9/10**. All 22 provider requests returned HTTP 200.
- Complete-response latency: **p50 344 ms, p95 463 ms**, nearest-rank over 22 successfully parsed responses. These are full verifier response times, including observed response metadata processing, not time-to-first-token. Skips and the initial duplicate are excluded. Timeouts would be counted separately rather than disguised as complete responses.
- Batch-reported cost sum: approximately **$0.002519**; initial request $0.000133. These are API usage metadata, not a billing guarantee.

Contradiction examples cover rejected pants acquisition, substituted agreement object, superseded agreement terms, rejected movement, dead NPC described alive, choices assuming unowned inventory, incorrect remaining gold, and instruction injection embedded in a contradictory draft. Missing evidence examples cover no source, lossy agreement summary, a player's request mistaken for a promise, and an unlisted acquisition. Valid cases include refusal after failed acquisition, matching and amended terms, negation, accepted new NPC/event/movement, a dead NPC correctly described, an attempted action choice, and success with a cost. Two atmospheric descriptions test the policy's fast path.

## Why valid drafts abstained

Every individual answer in all ten valid guarded cases selected `consistent`. Their probability/confidence values frequently missed the current acceptance thresholds (confidence >= 0.8 AND consistent probability >= 0.9 for every question).

| Question | Answers | Selected consistent | Confidence < 0.8 | Consistent probability < 0.9 | Confidence range |
| --- | ---: | ---: | ---: | ---: | --- |
| accepted_state | 10 | 10 | 4 | 6 | 0.39–0.96 |
| unlisted_events | 10 | 10 | 3 | 5 | 0.28–0.99 |
| outcome | 2 | 2 | 0 | 1 | 0.82–0.98 |
| history | 10 | 10 | 6 | 7 | 0.22–0.97 |
| choices | 10 | 10 | 1 | 1 | 0.28–0.98 |

Examples: the accepted new NPC missed only the history check (confidence 0.77, consistent probability 0.84); success with cost likewise missed only history (0.77 / 0.85). An attempted, non-guaranteed action choice got 0.28 / 0.52 on choices. Correct agreement terms got 0.81 / 0.88 on history and accepted_state. Correct failed-acquisition refusal had especially low confidence in accepted_state, unlisted_events and history despite selecting consistent.

These observations suggest studying narrowly scoped or atomic questions and making the no-applicable-assertion case clearer, then evaluating on held-out data. They do not justify weakening thresholds from this sample. Thresholds remain unchanged; the subsequent development iteration below changes prompts.

## Atomic-question development iteration

Independent review found that every answer in all ten valid guarded cases selected consistent; abstention came from threshold aggregation, not selection of insufficient. The policy now separates five historical aspects (parties, object, terms, time, status), distinguishes current changes from earlier state, and excludes mere intentions from acquisition claims. Fixtures specify current turn and collection completeness; the attempted-request fixture now includes its trader so it isolates intention from ownership.

A second development batch made 22 calls, all HTTP 200, with the same thresholds. Local evidence: `output/narrative-evaluation/run-2026-09-20T17-14-12-628Z.json`. Of ten valid guarded cases, two verified and eight abstained. All eight contradictory cases were rejected, all four insufficient cases abstained, and two descriptions skipped. Complete-response p50/p95 were 361/486 ms. Total calls across the initial probe and both batches: 45.

This remains an integration usability blocker. Atomic prompts alone did not solve aggregate abstention. These reused development fixtures are not a held-out validation set and are not evidence for lowering thresholds. Before activation, evaluate a calibrated decision policy on separate labelled paraphrases and actual serialized reducer state; do not silently treat uncertain as approval.

## Limits and next validation

This is a small, authored synthetic smoke/regression set, not a calibrated benchmark or production latency claim. Labels were not independently adjudicated. Fields are compact synthetic state snapshots rather than complete reducer output; real source retrieval and canonical state serialization are not exercised. The initial duplicate is the only repeated scenario; provider variation, concurrency, cold starts, regional effects and quota behaviour were not measured.

No repair generation ran, so repair rate, repair success and end-to-end turn latency are **not measured**. Abstention counts must not be presented as a repair rate. Long multi-turn error propagation, retrieval recall, campaign isolation, lease handling and UI buffering require separate integration tests. Fast-path lexical routing remains fallible; two safe descriptions do not demonstrate that consequential prose can never bypass selection.

Local evaluation tests pass (scoring denominators/status distinction, complete-response percentiles, labelled fixture routing); targeted ESLint passes. Concurrent whole-project typechecks encountered in-progress integration: initially a missing `narrative-guard` module, then a missing `parseCompleteNarrativeDraft` export in `tests/narrative-stream.test.ts`. Neither error is in evaluation-owned files; the parent task is responsible for the final repository-wide check.
