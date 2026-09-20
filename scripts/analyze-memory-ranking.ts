/** Offline ablation over the reviewed real snapshot and cached provider embeddings. No network. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { EMBEDDING_MODEL, formatDocument, formatQuery, cosine } from "../src/lib/vector";
import { retrievalMetrics, type EvalQuestion } from "./memory-eval-fixture";

const directory = "output/memory-evaluation";
async function cached(texts: string[]) {
  const name = createHash("sha256").update(JSON.stringify([EMBEDDING_MODEL, 3072, texts])).digest("hex");
  const bytes = await readFile(`${directory}/cache/${name}.bin`);
  if (bytes.length !== texts.length * 3072 * 4) throw new Error("Invalid cached vector size");
  return texts.map((_, i) => Array.from({ length: 3072 }, (_, j) => bytes.readFloatLE((i * 3072 + j) * 4)));
}
async function main() {
  const nodes = JSON.parse(await readFile(`${directory}/real-memory.json`, "utf8")) as { id: string; title: string; content: string; importance: number; salience: number; source: string; layer: string; turn_to: number | null }[];
  const questions = JSON.parse(await readFile(`${directory}/real-questions.json`, "utf8")) as EvalQuestion[];
  const docs = await cached(nodes.map(n => formatDocument(n.title,n.content)));
  const queries = await cached(questions.map(q => formatQuery(q.query)));
  const summaries = [];
  for (const dims of [768,1536,3072]) for (const mode of ["production", "no-recency", "cosine-with-layer-cap", "semantic-85", "pure-cosine"]) {
    const outcomes = questions.map((q, qi) => {
      const candidates = nodes.map((n, ni) => {
        const similarity = cosine(queries[qi].slice(0,dims), docs[ni].slice(0,dims));
        const importance = n.importance / 100;
        const age = Math.max(0, 41 - (n.turn_to ?? 0));
        const freshness = Math.max(0, 1 - age / 60);
        const provenance = n.source === "state" ? 1 : n.source === "seed" ? .95 : n.source === "compaction" ? .85 : .8;
        const salience = n.salience / 100;
        let score = similarity * .55 + importance * .2 + freshness * .1 + salience * .05 + provenance * .1;
        if (mode === "no-recency") score -= freshness * .1;
        if (mode === "semantic-85") score = similarity * .85 + importance * .05 + freshness * .025 + salience * .025 + provenance * .05;
        if (mode === "pure-cosine" || mode === "cosine-with-layer-cap") score = similarity;
        return { id: n.id, layer: n.layer, similarity, score };
      }).filter(n => mode === "pure-cosine" || n.similarity >= .35).sort((a,b) => b.score - a.score || a.id.localeCompare(b.id));
      const layers = new Map<string,number>();
      const ids = candidates.filter(n => { const count = (layers.get(n.layer) ?? 0) + 1; layers.set(n.layer,count); return mode === "pure-cosine" || count <= 4; }).slice(0,8).map(n => n.id);
      return { id: q.id, ...retrievalMetrics(ids,q.relevant) };
    });
    const summary = { dims, mode, hit1: outcomes.reduce((s,r) => s+r.hit1,0)/outcomes.length, recall8: outcomes.reduce((s,r) => s+r.recall8,0)/outcomes.length, mrr8: outcomes.reduce((s,r) => s+r.mrr8,0)/outcomes.length };
    summaries.push(summary);
    console.log(JSON.stringify(summary));
  }
  await writeFile(`${directory}/ranking-ablation.json`, JSON.stringify({ note: "Exploratory analysis on the same 12 questions, not independent validation or a production recommendation", summaries },null,2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Offline analysis failed"); process.exitCode = 1; });
