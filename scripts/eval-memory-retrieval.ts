/** Opt-in live Gemini evaluation. Local corpus/cache/results only; never writes a deployed DB. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { buildEvalCorpus, retrievalMetrics, type EvalMemory, type EvalQuestion } from "./memory-eval-fixture";
import { formatDocument, formatQuery, EMBEDDING_MODEL } from "../src/lib/vector";
import { memorySearchDb, sessionId } from "../tests/helpers/memory-search-db";
import { buildMemorySearchQuery, type DatabaseSearchResult } from "../src/lib/memory-search";

const directory = "output/memory-evaluation";
const live = process.argv.includes("--live");
const cacheOnly = process.argv.includes("--cached");
const requestedSize = Number(process.argv.find(arg => arg.startsWith("--size="))?.slice(7) ?? 800);
const realOnly = process.argv.includes("--real-only");
const distractorOnly = process.argv.includes("--distractors-only");
const maximumRequests = 150;
let requests = 0;
let processedTexts = 0;
const maximumTexts = 950;
const usage: { dims: number; items: number; ms: number; status: number; tokens: number | null }[] = [];
const key = process.env.GEMINI_API_KEY?.trim();
const recent: { at: number; items: number }[] = [];

async function pace(items: number) {
  if (items > 90) throw new Error("Batch exceeds the conservative free-tier per-minute budget");
  while (true) {
    while (recent.length && recent[0].at < Date.now() - 61000) recent.shift();
    if (recent.reduce((sum,r) => sum + r.items, 0) + items <= 90) return;
    await new Promise(resolve => setTimeout(resolve, Math.min(60000, Math.max(1, 61001 - (Date.now() - recent[0].at)))));
  }
}

async function embed(texts: string[], dims = 3072, cache = true): Promise<Float32Array[]> {
  const name = createHash("sha256").update(JSON.stringify([EMBEDDING_MODEL, dims, texts])).digest("hex");
  const path = `${directory}/cache/${name}.bin`;
  if (cache) {
    try {
      const bytes = await readFile(path);
      if (bytes.length !== texts.length * dims * 4) throw new Error("Invalid cached embedding size");
      return texts.map((_, i) => Float32Array.from({ length: dims }, (_, j) => bytes.readFloatLE((i * dims + j) * 4)));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  // Small batches tolerate shared-project RPM usage; old larger cache files still work.
  if (texts.length > 20) {
    const vectors: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 20) vectors.push(...await embed(texts.slice(i, i + 20), dims, cache));
    if (cache) {
      const bytes = Buffer.alloc(texts.length * dims * 4);
      vectors.forEach((v,i) => v.forEach((x,j) => bytes.writeFloatLE(x,(i*dims+j)*4)));
      await writeFile(path,bytes);
    }
    return vectors;
  }
  if (!live || !key) throw new Error("Use --live with GEMINI_API_KEY for uncached embeddings");
  for (let attempt = 0; attempt < 3; attempt++) {
    await pace(texts.length);
    if (processedTexts + texts.length > maximumTexts) throw new Error("Evaluation text budget exhausted; cached progress retained");
    if (++requests > maximumRequests) throw new Error("Evaluation request budget exhausted; cached progress retained");
    const requestId = randomUUID();
    processedTexts += texts.length;
    await appendFile(`${directory}/attempts.jsonl`, JSON.stringify({ requestId, dims, items: texts.length, at: Date.now() }) + "\n");
    const started = performance.now();
    const batch = texts.length > 1;
    const payload = (text: string) => ({ model: `models/${EMBEDDING_MODEL}`, content: { parts: [{ text }] }, outputDimensionality: dims });
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:${batch ? "batchEmbedContents" : "embedContent"}`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, signal: AbortSignal.timeout(45000),
      body: JSON.stringify(batch ? { requests: texts.map(payload) } : payload(texts[0])),
    });
    const entry = { requestId, dims, items: texts.length, ms: Math.round(performance.now() - started), status: response.status, tokens: null as number | null, timing: "full-response" };
    usage.push(entry);
    if (!response.ok) {
      // Inspect retry guidance only; never persist provider error bodies.
      const error = await response.json() as { error?: { details?: { retryDelay?: string; violations?: { quotaId?: string; quotaValue?: string }[] }[] } };
      entry.ms = Math.round(performance.now() - started);
      await appendFile(`${directory}/requests.jsonl`, JSON.stringify({ ...entry, at: Date.now() }) + "\n");
      if (response.status < 500) processedTexts -= texts.length;
      console.log(JSON.stringify({ status: response.status, quota: error.error?.details?.flatMap(d => d.violations ?? []) .map(v => ({ id: v.quotaId, value: v.quotaValue })), retryDelay: error.error?.details?.find(d => d.retryDelay)?.retryDelay }));
      if (error.error?.details?.some(d => d.violations?.some(v => v.quotaId?.includes("PerDay")))) throw new Error("Daily Gemini quota exhausted; no retries until quota is available");
      const delay = Number.parseFloat(error.error?.details?.find(d => d.retryDelay)?.retryDelay ?? "0") * 1000;
      if ([429, 500, 502, 503].includes(response.status) && attempt < 2) { await new Promise(resolve => setTimeout(resolve, Math.min(60000, Math.max(delay + 1000, 5000 * (attempt + 1))))); continue; }
      throw new Error(`Gemini HTTP ${response.status}; evaluation stopped, cache retained`);
    }
    recent.push({ at: Date.now(), items: texts.length });
    const data = await response.json() as { embeddings?: { values: number[] }[]; embedding?: { values: number[] } };
    if (!batch && data.embedding) data.embeddings = [data.embedding];
    entry.ms = Math.round(performance.now() - started);
    await appendFile(`${directory}/requests.jsonl`, JSON.stringify({ ...entry, at: Date.now() }) + "\n");
    if (data.embeddings?.length !== texts.length || data.embeddings.some(e => e.values.length !== dims || e.values.some(v => !Number.isFinite(v)))) throw new Error("Invalid embedding response");
    const bytes = Buffer.alloc(texts.length * dims * 4);
    data.embeddings.forEach((e, i) => e.values.forEach((v, j) => bytes.writeFloatLE(v, (i * dims + j) * 4)));
    if (cache) await writeFile(path, bytes);
    return data.embeddings.map(e => Float32Array.from(e.values));
  }
  throw new Error("Embedding retries exhausted");
}

function prefix(vector: Float32Array, dims: number): number[] {
  const values = Array.from(vector.subarray(0, dims));
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return values.map(v => v / norm);
}
function similarity(a: number[], b: number[]) { return a.reduce((sum, v, i) => sum + v * b[i], 0); }
function median(values: number[]) { const sorted = [...values].sort((a,b) => a-b); return sorted[Math.floor(sorted.length / 2)]; }

async function realFixture(): Promise<{ memories: EvalMemory[]; questions: EvalQuestion[] } | null> {
  let rows: { id: string; title: string; content: string; layer: string; importance: number; salience: number; source: string; turn_to: number | null }[];
  try { rows = JSON.parse(await readFile(`${directory}/real-memory.json`, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const questions = JSON.parse(await readFile(`${directory}/real-questions.json`, "utf8")) as EvalQuestion[];
  if (!questions.length || questions.some(q => !q.relevant.length || q.relevant.some(id => !rows.some(r => r.id === id)))) throw new Error("Invalid real-memory labels");
  return { memories: rows.map(r => ({ ...r, turnTo: r.turn_to ?? 0, genre: "real" })), questions };
}

async function evaluate(memories: EvalMemory[], questions: EvalQuestion[], docs: Float32Array[], queries: Float32Array[], dims: number, label: string, currentTurn: number) {
  const pg = await memorySearchDb();
  try {
    for (let start = 0; start < memories.length; start += 100) {
      const batch = memories.slice(start, start + 100);
      await pg.query(`INSERT INTO memory_nodes (id,session_id,title,content,layer,importance,salience,source,turn_to)
        SELECT id,$2::uuid,title,content,layer,importance,salience,source,"turnTo" FROM jsonb_to_recordset($1::jsonb)
        AS n(id uuid,title text,content text,layer text,importance real,salience real,source text,"turnTo" integer)`, [JSON.stringify(batch), sessionId]);
      await pg.query(`INSERT INTO memory_embeddings
        SELECT n.id,n.id,n.session_id,$2,$3,'ready',chronicle_embedding_hash($2,$3,n.title,n.content),v.vector
        FROM jsonb_to_recordset($1::jsonb) AS v(id uuid,vector real[]) JOIN memory_nodes n ON n.id=v.id`,
      [JSON.stringify(batch.map((n, i) => ({ id: n.id, vector: prefix(docs[start + i], dims) }))), EMBEDDING_MODEL, dims]);
    }
    await pg.exec("ANALYZE memory_nodes; ANALYZE memory_embeddings");
    const results: { id: string; genre: string; relevant: string[]; production: ReturnType<typeof retrievalMetrics>; pure: ReturnType<typeof retrievalMetrics>; ranked: string[]; pureRanked: string[]; ms: number; bytes: number; candidates: number }[] = [];
    // Both pipelines operate on the same index. Pure cosine is diagnostic, not product behavior.
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i], vector = prefix(queries[i], dims);
      const query = buildMemorySearchQuery({ sessionId, model: EMBEDDING_MODEL, dims, vector, currentTurn });
      const started = performance.now();
      const result = (await pg.query<DatabaseSearchResult>(query.text, query.values)).rows[0];
      const ms = performance.now() - started;
      const pure = (await pg.query<{ id: string }>(`SELECT memory_node_id AS id FROM memory_embeddings ORDER BY vector::vector <=> $1::vector, memory_node_id LIMIT 8`, [JSON.stringify(vector)])).rows.map(n => n.id);
      const ranked = result.results.map(n => n.id);
      results.push({ id: q.id, genre: q.genre, relevant: q.relevant, production: retrievalMetrics(ranked, q.relevant), pure: retrievalMetrics(pure, q.relevant), ranked, pureRanked: pure, ms, bytes: Buffer.byteLength(JSON.stringify(result)), candidates: result.candidates });
    }
    const mean = (field: "production" | "pure", metric: "hit1" | "recall8" | "mrr8") => results.reduce((sum,r) => sum + r[field][metric], 0) / results.length;
    const summary = { label, count: memories.length, dims, questions: questions.length, production: { hit1: mean("production","hit1"), recall8: mean("production","recall8"), mrr8: mean("production","mrr8") }, pure: { hit1: mean("pure","hit1"), recall8: mean("pure","recall8"), mrr8: mean("pure","mrr8") }, medianSqlMs: +median(results.map(r => r.ms)).toFixed(1), maxResponseBytes: Math.max(...results.map(r => r.bytes)) };
    await writeFile(`${directory}/${label}-${dims}.json`, JSON.stringify({ summary, results }, null, 2));
    console.log(JSON.stringify(summary));
    return summary;
  } finally { await pg.close(); }
}

async function main() {
  const corpus = buildEvalCorpus(requestedSize);
  if (!live && !cacheOnly) { console.log(`DRY RUN: ${corpus.memories.length} unique synthetic facts, ${corpus.questions.length} fixed questions, max ${maximumRequests} HTTP attempts. Add --live or --cached.`); return; }
  await mkdir(`${directory}/cache`, { recursive: true });
  try {
    const ledger = (await readFile(`${directory}/requests.jsonl`, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    processedTexts = ledger.filter(r => r.status === 200).reduce((sum,r) => sum + r.items, 0);
    let attempts: { requestId: string; items: number; at: number }[] = [];
    try { attempts = (await readFile(`${directory}/attempts.jsonl`, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    for (const attempt of attempts) {
      const response = ledger.find(r => r.requestId === attempt.requestId);
      if (!response || response.status >= 500) processedTexts += attempt.items;
    }
    requests = ledger.filter(r => !r.requestId).length + attempts.length;
    for (const r of ledger) if (r.status === 200 && r.at > Date.now() - 61000) recent.push({ at: r.at, items: r.items });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const real = await realFixture();
  // Validate MRL prefixes against directly requested dimensions before scaling.
  const sampleTexts = [formatDocument(corpus.memories[0].title, corpus.memories[0].content), formatQuery(corpus.questions[0].query)];
  const full = await embed(sampleTexts);
  const prefixChecks = [];
  for (const dims of [768,1536]) {
    const direct = await embed(sampleTexts, dims);
    const scores = direct.map((v,i) => similarity(prefix(v,dims), prefix(full[i],dims)));
    prefixChecks.push({ dims, cosine: scores });
    if (scores.some(s => s < .9999)) throw new Error("Direct dimension/prefix equivalence failed; do not reuse prefixes");
  }
  await writeFile(`${directory}/prefix-check.json`, JSON.stringify(prefixChecks,null,2));
  const realDocs = real ? await embed(real.memories.map(n => formatDocument(n.title,n.content))) : [];
  const realQueries = real ? await embed(real.questions.map(q => formatQuery(q.query))) : [];
  const summaries = [];
  if (real) for (const dims of [768,1536,3072]) summaries.push(await evaluate(real.memories, real.questions, realDocs, realQueries, dims, "real", 41));
  const docs: Float32Array[] = [];
  if (!realOnly) {
    // Fetch questions before a large document run so a partial corpus can still be evaluated.
    const queryVectors = distractorOnly ? [] : await embed(corpus.questions.map(q => formatQuery(q.query)));
    for (let start = 0; start < corpus.memories.length; start += 90) {
      docs.push(...await embed(corpus.memories.slice(start,start+90).map(n => formatDocument(n.title,n.content))));
      console.log(`EMBEDDED ${docs.length}/${corpus.memories.length}; recorded HTTP attempts: ${requests}`);
    }
    for (const dims of [768,1536,3072]) {
      if (distractorOnly) {
        if (!real) throw new Error("Distractor evaluation requires the reviewed real corpus and questions");
        summaries.push(await evaluate([...real.memories,...corpus.memories],real.questions,[...realDocs,...docs],realQueries,dims,`real-plus-${requestedSize}`,41));
      } else {
        for (const count of [...new Set([100,1000,10000].filter(n => n <= requestedSize).concat(requestedSize))]) summaries.push(await evaluate(corpus.memories.slice(0,count), corpus.questions, docs.slice(0,count), queryVectors, dims, `synthetic-${count}`, 120));
      }
    }
    // Direct single-input calls at each size; latency is local-to-Gemini, not Vercel-to-Gemini.
    for (let repeat = 0; repeat < (cacheOnly ? 0 : 6); repeat++) for (const dims of [768,1536,3072].slice(repeat % 3).concat([768,1536,3072].slice(0,repeat % 3))) {
      await embed([formatQuery(corpus.questions[repeat].query)], dims, false);
    }
  }
  await writeFile(`${directory}/summary.json`, JSON.stringify({ model: EMBEDDING_MODEL, prefixChecks, summaries, recordedHttpAttempts: requests, usage, limitations: ["24 authored synthetic questions, 12 reviewed real questions; not a population estimate", "Synthetic distractors are template-generated across genres, not 10,000 organic player memories", "PGlite SQL durations exclude network, provider, readiness probes, and cold server startup", "Dimensions use validated normalized MRL prefixes", "Real snapshot and embeddings stay in ignored output directory; source DB was read-only"] }, null, 2));
  console.log(`COMPLETE ${summaries.length} scenarios; ${requests} recorded HTTP attempts. Results: ${directory}/summary.json`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Memory evaluation failed"); process.exitCode = 1; });
