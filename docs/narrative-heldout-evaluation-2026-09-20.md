# Held-out synthetic narrative verification — 2026-09-20

This report records the policy at measurement time. Subsequent administrator fallback, default enablement and outage bypass are documented in the [release guide](narrative-verification-release.md); these measurements do not establish the bypassed drafts' correctness.

The unchanged strict policy verified **10/12 valid held-out drafts**, rejected all 10 contradictions, and abstained on all 6 insufficient-evidence drafts. A preselected research comparator requiring every selected answer to choose `consistent` verified 12/12 valid drafts and accepted 0/16 non-consistent drafts. This supports investigating semantic unanimity; it does not establish calibrated safety or justify silently treating runtime uncertainty as approval.

## Design and separation

`scripts/narrative-heldout-fixtures.ts` contains 28 new synthetic Russian cases, each with an explicit expected label and human-readable rationale. A separate evaluation agent authored these without copying development scenarios, after seeing the earlier development results. Labels and the comparator were fixed before any holdout call. This is independently authored holdout content, **not independently adjudicated gold data**: one agent authored all labels. It shares the development state vocabulary and risk categories, so it is not an independent production-distribution sample.

Cases cover multi-event trades and movement, an incorrect clause mixed with correct clauses, partial descriptions, negation and double negation, conditional choices, existing ownership, removed inventory, failed attempts, success with health costs, unchanged NPC location, historical party/object/condition substitution, amendments changing only one term, superseded versus historically accurate deadlines, unfulfilled obligations, omitted state fields, lossy summaries, equally authoritative conflicting sources, player intent, additional unsupported events, and unsupported calendar dates. All 28 require verification; fast-path routing recall is not tested here.

Frozen fixture serialization SHA-256: `96e7917bf6132d9a3e3a13fdfa9318a5c9bbc8c8e01e0b2738c9b12268bb6130`.

## Development evidence and candidate rule

Saved development batch `output/narrative-evaluation/run-2026-09-20T17-14-12-628Z.json` has 10 valid guarded cases. Every answer on every valid case chose `consistent`; the lowest per-draft consistent probabilities range from 0.59 to 0.97, and lowest confidences from 0.38 to 0.95. The strict conjunction of confidence >= 0.8 and probability >= 0.9 accepts only 2/10. Every one of the 12 non-consistent drafts has at least one dissenting answer.

The candidate therefore removes numeric acceptance cutoffs and requires **unanimous selected `consistent` labels across all existing questions**, preserving strict rejection and all unavailable/skipped results. It is implemented only in the evaluation script. This is a meaningful relaxation of policy despite not fitting a numeric threshold. It would accept weak unanimous predictions; provider scores have not been shown to be calibrated probabilities of correctness. No history question is removed and no majority vote can hide a dissenting factual facet.

Development result: candidate accepts 10/10 valid guarded drafts, rejects 8/8 contradictions, abstains on 4/4 insufficient cases; two descriptions skip. This is selection evidence, not validation. No candidate was retuned after holdout results.

## Held-out results

| Label | Cases | Strict verified | Strict rejected | Strict uncertain | Candidate verified | Candidate uncertain |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Consistent | 12 | 10 | 0 | 2 | 12 | 0 |
| Contradicts | 10 | 0 | 10 | 0 | 0 | 0 |
| Insufficient | 6 | 0 | 0 | 6 | 0 | 6 |

The candidate preserves all 10 strict rejections. Both policies have 0/16 observed unsafe acceptances and 0/12 explicit false rejections. Strict valid abstention is 2/12 (16.7%); candidate valid abstention is 0/12. There were no unavailable calls and no bypasses.

The two strict misses are `h08_existing_owned_choice` (history_object confidence/probability 0.70/0.80; history_terms 0.84/0.89; history_status 0.81/0.88) and `h11_npc_location` (accepted_state 0.72/0.81). Every answer still chooses consistent. Historical facets remain uncertain about an existing carried object even without an asserted historical acquisition. The strict coverage difference from development (20% versus 83.3%) is itself evidence of substantial corpus sensitivity; this experiment cannot attribute the improvement to prompt or serialization changes because neither was randomized.

Twenty-eight sequential synthetic requests, 1,200 ms pacing, 5,000 ms deadline, zero retries; all HTTP 200. Observed model: `typesafe/jev-1.13-20260917`. Complete-response latency p50/p95 **381/687 ms**, nearest-rank over 28 parsed results. Reported usage cost sum approximately **$0.009089**, not a billing guarantee. Evidence: ignored local `output/narrative-evaluation/heldout-2026-09-20T17-19-10-381Z.json`. The file stores fixture IDs, labels, parsed verdicts/scores, timings and usage, not request state, credentials, source prose, or raw responses. No database or private campaign was accessed.

## Practical decision

Keep the integrated guard opt-in with the current strict policy and canonical, non-assertive fallback on uncertainty/unavailability. That resolves publication safety without presenting an uncertain generated draft as verified; it does not eliminate the associated usability cost. Do not repair repeatedly just because every semantic label is consistent: that can distort correct text and adds latency.

The next concrete calibration experiment is to run the **frozen unanimous-consistent rule in shadow mode against actual serialized reducer state**, paired with strict decisions, on a larger separately authored and independently reviewed synthetic set. Oversample missing evidence, cross-facet contradictions, no-applicable-history assertions, and multi-event cases. Repeat selected cases to measure provider variation, and set an acceptable false-accept bound before collecting data. If an experimental acceptance mode is desired sooner, expose it explicitly as an uncalibrated option; this report does not recommend enabling it by default.

Even under independent identically distributed Bernoulli assumptions, zero errors among only 16 unsafe examples leaves a one-sided 95% upper error-rate bound of about 17.1% (`1 - 0.05^(1/16)`). Those assumptions are not justified for authored examples. This set says nothing about adversarial completeness, retrieval recall, actual campaign distribution, guard orchestration, repair success, or end-to-end turn latency. It is now consumed holdout data and must not be called fresh validation after further tuning.

## Reproduction and checks

```powershell
node --import tsx scripts/eval-narrative-heldout.ts
node --env-file-if-exists=.env --import tsx scripts/eval-narrative-heldout.ts --live
npx eslint scripts/narrative-heldout-fixtures.ts scripts/eval-narrative-heldout.ts
```

Default mode makes no network requests. The ignored development artifact is optional for fresh checkouts. Live mode makes at most 28 requests for the present fixtures, stops on authentication/payment/quota errors or incompatible protocol, never retries, and has a hard cap of 30 requests. A rerun is another paid sample and must not be combined with this batch as though it were the original holdout. Targeted ESLint and a dry run passed. No shared policy, verifier, schema or turn implementation was edited by this evaluation task.
