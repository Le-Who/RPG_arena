/** Publish aggregates only; private corpus, questions and vectors remain under ignored output/. */
import { readFile, writeFile } from "node:fs/promises";
type Summary = { label: string; count: number; dims: number; questions: number; production: { hit1: number; recall8: number; mrr8: number }; pure: { hit1: number; recall8: number; mrr8: number }; medianSqlMs: number; maxResponseBytes: number };
async function main() {
  const directory = "output/memory-evaluation";
  const report = JSON.parse(await readFile(`${directory}/summary.json`, "utf8")) as { summaries: Summary[] };
  if (!report.summaries.some(r => r.label === "real-plus-710" && r.count === 777)) throw new Error("The 777-node cached run has not completed");
  const ledger = (await readFile(`${directory}/requests.jsonl`, "utf8")).trim().split("\n").map(line => JSON.parse(line)) as { status: number; items: number; dims: number; ms: number; timing?: string }[];
  const ablation = JSON.parse(await readFile(`${directory}/ranking-ablation.json`, "utf8")) as { summaries: { dims: number; mode: string; recall8: number; hit1: number }[] };
  const percent = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = ["# Live memory retrieval evaluation · 2026-09-20", "", "## Scope and limits", "",
    "Compared gemini-embedding-2 at 768, 1536 and 3072 dimensions. Completed scenarios use a read-only local snapshot of 67 real memories, then those same memories plus 710 unique synthetic distractors (777 total). Both use the same 12 manually labelled real questions. The added texts comprise 48 authored examples and 662 template-generated distractors across four genres, not organically played campaign history. Template diversity is limited: this prefix uses only a subset of the available objects/actions. Synthetic metadata spans all four memory layers. Labels were fixed before embedding.", "",
    "The provider reported a 100-input RPM limit and eventually the 1,000-input daily quota violation. Live requests stopped. The planned 800-document synthetic corpus and its 24 authored questions were not completed; those questions have no cached embeddings and are not evaluated here. The larger completed scenario was replayed entirely from cached vectors. Neither 1,000 nor 10,000 unique-memory semantic testing is complete. Separate earlier synthetic-vector load tests cover up to 50,000 rows; they do not measure semantic quality.", "",
    "Full 3072-dimensional embeddings are cached. Smaller dimensions use normalized prefixes, as supported by Matryoshka Representation Learning. A document and a query were also requested directly at 768/1536: cosine with the derived prefix exceeded 0.99999999999999. This is a spot check, not an exhaustive equivalence test.", "",
    "## Retrieval quality", "",
    "Recall@8 is the fraction of labelled relevant memories found in the first eight, averaged across questions. Pure cosine has no metadata weighting, minimum-similarity threshold or layer cap; the production column includes all three. Production denotes the application ranking formula executed locally, not a production-site measurement. These are component retrieval tests, not complete gameplay or answer-quality evaluations. The real questions are direct questions, not the full context-enriched turn query. Twelve questions from one real campaign cannot establish general quality across genres or long campaigns.", "",
    "| Corpus | Dimensions | Production recall@8 | Pure recall@8 | Production hit@1 | Pure hit@1 |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...report.summaries.map(r => `| ${r.label} (${r.count}) | ${r.dims} | ${percent(r.production.recall8)} | ${percent(r.pure.recall8)} | ${percent(r.production.hit1)} | ${percent(r.pure.hit1)} |`), "",
    "## Local exact SQL query duration", "",
    "PostgreSQL/pgvector runs locally in PGlite/WASM. Medians cover different questions, with no repeated-query warmup protocol. They exclude Neon/Vercel network latency, readiness probes, provider time, cold starts and narration generation. They must not be read as production turn latency.", "",
    "| Corpus | Dimensions | Median SQL ms | Largest response bytes |", "| --- | ---: | ---: | ---: |",
    ...report.summaries.map(r => `| ${r.label} | ${r.dims} | ${r.medianSqlMs} | ${r.maxResponseBytes} |`), "",
    "## Query embedding API duration", "",
    "The planned six full-response single-query measurements per dimension were not executed because the daily quota was exhausted. Early diagnostic measurements stopped at response headers and are excluded. No conclusion about dimensionality versus provider latency or total turn time is supported by this run."];
  lines.push("", "## Exploratory ranking ablation", "", "On the same real questions (not a held-out validation set):", "",
    "| Mode | 768 recall@8 | 1536 recall@8 | 3072 recall@8 |", "| --- | ---: | ---: | ---: |");
  for (const mode of ["production","no-recency","cosine-with-layer-cap","semantic-85","pure-cosine"]) lines.push(`| ${mode} | ${[768,1536,3072].map(d => percent(ablation.summaries.find(r => r.mode === mode && r.dims === d)!.recall8)).join(" | ")} |`);
  lines.push("", "This identifies metadata weighting, especially freshness, as a candidate source of lost relevance in this sample. The experiment does not justify deploying a new weight without separate questions, current-fact versus outdated-fact cases, multi-evidence queries and no-answer tests. No game ranking weights or player settings were changed.", "", "## Usage and reproducibility", "",
    `The ledger records ${ledger.filter(r => r.status === 200).length} successful HTTP calls processing ${ledger.filter(r => r.status === 200).reduce((s,r) => s+r.items,0)} text inputs, plus ${ledger.filter(r => r.status !== 200).length} rejected HTTP calls. Two separate quota diagnostics were outside this ledger: one rejected 100-input batch and one successful single-input call. These are observed request counts, not an authoritative provider billing or quota report. Rejected inputs may affect quota accounting; other project activity is not tracked.`, "",
    "The evaluator persists attempts, reserves uncertain in-flight work, paces successful batches and caps its own recorded work. A live run requires --live and GEMINI_API_KEY; --cached recomputes quality without provider calls. Cache/results and the real snapshot/questions are ignored by Git. Do not clear the ledger/cache to work around a quota limit. Actual token counts/cost were not returned by these embedding responses.", "",
    "Cached replay requires the private local artifacts created by this run; they are deliberately not committed. Resume live work only after quota is available, preserving the existing cache and ledgers.", "",
    "```powershell", "node --import tsx scripts/eval-memory-retrieval.ts --cached --size=710 --distractors-only", "node --import tsx scripts/analyze-memory-ranking.ts", "node --import tsx scripts/report-memory-evaluation.ts", "```", "",
    "The source campaign database was read-only. No campaign progress, ownership, stored API key, index or production schema was modified. API inputs were sent only to the user-authorized Gemini embedding service. The source DB credential was kept in a temporary file and removed.", "",
    "Reference: [Gemini embedding size and MRL](https://ai.google.dev/gemini-api/docs/embeddings#controlling-embedding-size).", "");
  await writeFile("docs/live-memory-evaluation.md", lines.join("\n"));
  console.log("Wrote docs/live-memory-evaluation.md (aggregate results only)");
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Report generation failed"); process.exitCode = 1; });
