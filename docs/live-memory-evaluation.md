# Live memory retrieval evaluation · 2026-09-20

## Scope and limits

Compared gemini-embedding-2 at 768, 1536 and 3072 dimensions. Completed scenarios use a read-only local snapshot of 67 real memories, then those same memories plus 710 unique synthetic distractors (777 total). Both use the same 12 manually labelled real questions. The added texts comprise 48 authored examples and 662 template-generated distractors across four genres, not organically played campaign history. Template diversity is limited: this prefix uses only a subset of the available objects/actions. Synthetic metadata spans all four memory layers. Labels were fixed before embedding.

The provider reported a 100-input RPM limit and eventually the 1,000-input daily quota violation. Live requests stopped. The planned 800-document synthetic corpus and its 24 authored questions were not completed; those questions have no cached embeddings and are not evaluated here. The larger completed scenario was replayed entirely from cached vectors. Neither 1,000 nor 10,000 unique-memory semantic testing is complete. Separate earlier synthetic-vector load tests cover up to 50,000 rows; they do not measure semantic quality.

Full 3072-dimensional embeddings are cached. Smaller dimensions use normalized prefixes, as supported by Matryoshka Representation Learning. A document and a query were also requested directly at 768/1536: cosine with the derived prefix exceeded 0.99999999999999. This is a spot check, not an exhaustive equivalence test.

## Retrieval quality

Recall@8 is the fraction of labelled relevant memories found in the first eight, averaged across questions. Pure cosine has no metadata weighting, minimum-similarity threshold or layer cap; the production column includes all three. Production denotes the application ranking formula executed locally, not a production-site measurement. These are component retrieval tests, not complete gameplay or answer-quality evaluations. The real questions are direct questions, not the full context-enriched turn query. Twelve questions from one real campaign cannot establish general quality across genres or long campaigns.

| Corpus | Dimensions | Production recall@8 | Pure recall@8 | Production hit@1 | Pure hit@1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| real (67) | 768 | 70.8% | 100.0% | 50.0% | 83.3% |
| real (67) | 1536 | 70.8% | 100.0% | 50.0% | 91.7% |
| real (67) | 3072 | 70.8% | 100.0% | 50.0% | 91.7% |
| real-plus-710 (777) | 768 | 58.3% | 100.0% | 33.3% | 83.3% |
| real-plus-710 (777) | 1536 | 66.7% | 100.0% | 33.3% | 91.7% |
| real-plus-710 (777) | 3072 | 66.7% | 100.0% | 33.3% | 91.7% |

## Local exact SQL query duration

PostgreSQL/pgvector runs locally in PGlite/WASM. Medians cover different questions, with no repeated-query warmup protocol. They exclude Neon/Vercel network latency, readiness probes, provider time, cold starts and narration generation. They must not be read as production turn latency.

| Corpus | Dimensions | Median SQL ms | Largest response bytes |
| --- | ---: | ---: | ---: |
| real | 768 | 8.3 | 7626 |
| real | 1536 | 10.8 | 7634 |
| real | 3072 | 15.7 | 7626 |
| real-plus-710 | 768 | 34.9 | 5524 |
| real-plus-710 | 1536 | 62.1 | 5515 |
| real-plus-710 | 3072 | 86.4 | 5532 |

## Query embedding API duration

The planned six full-response single-query measurements per dimension were not executed because the daily quota was exhausted. Early diagnostic measurements stopped at response headers and are excluded. No conclusion about dimensionality versus provider latency or total turn time is supported by this run.

## Exploratory ranking ablation

On the same real questions (not a held-out validation set):

| Mode | 768 recall@8 | 1536 recall@8 | 3072 recall@8 |
| --- | ---: | ---: | ---: |
| production | 70.8% | 70.8% | 70.8% |
| no-recency | 91.7% | 91.7% | 91.7% |
| cosine-with-layer-cap | 100.0% | 100.0% | 100.0% |
| semantic-85 | 100.0% | 100.0% | 100.0% |
| pure-cosine | 100.0% | 100.0% | 100.0% |

This identifies metadata weighting, especially freshness, as a candidate source of lost relevance in this sample. The experiment does not justify deploying a new weight without separate questions, current-fact versus outdated-fact cases, multi-evidence queries and no-answer tests. No game ranking weights or player settings were changed.

## Usage and reproducibility

The ledger records 32 successful HTTP calls processing 795 text inputs, plus 12 rejected HTTP calls. Two separate quota diagnostics were outside this ledger: one rejected 100-input batch and one successful single-input call. These are observed request counts, not an authoritative provider billing or quota report. Rejected inputs may affect quota accounting; other project activity is not tracked.

The evaluator persists attempts, reserves uncertain in-flight work, paces successful batches and caps its own recorded work. A live run requires --live and GEMINI_API_KEY; --cached recomputes quality without provider calls. Cache/results and the real snapshot/questions are ignored by Git. Do not clear the ledger/cache to work around a quota limit. Actual token counts/cost were not returned by these embedding responses.

Cached replay requires the private local artifacts created by this run; they are deliberately not committed. Resume live work only after quota is available, preserving the existing cache and ledgers.

```powershell
node --import tsx scripts/eval-memory-retrieval.ts --cached --size=710 --distractors-only
node --import tsx scripts/analyze-memory-ranking.ts
node --import tsx scripts/report-memory-evaluation.ts
```

The source campaign database was read-only. No campaign progress, ownership, stored API key, index or production schema was modified. API inputs were sent only to the user-authorized Gemini embedding service. The source DB credential was kept in a temporary file and removed.

Reference: [Gemini embedding size and MRL](https://ai.google.dev/gemini-api/docs/embeddings#controlling-embedding-size).
