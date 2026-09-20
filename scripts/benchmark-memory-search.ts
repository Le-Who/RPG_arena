/** Synthetic, isolated PostgreSQL/WASM benchmark. Never reads DATABASE_URL or calls Gemini. */
import { performance } from "node:perf_hooks";
import { memorySearchDb, model, sessionId } from "../tests/helpers/memory-search-db";
import { buildMemorySearchQuery, type DatabaseSearchResult } from "../src/lib/memory-search";
import { cosine } from "../src/lib/vector";

const sizes = (process.env.MEMORY_BENCH_SIZES ?? "100,1000,10000,50000").split(",").map(Number);
const dimensions = (process.env.MEMORY_BENCH_DIMS ?? "768,1536,3072").split(",").map(Number);
if (sizes.some(n => !Number.isInteger(n) || n < 1 || n > 50000) || dimensions.some(n => ![768, 1536, 3072].includes(n))) throw new Error("Invalid benchmark sizes/dimensions");

async function main() {
  for (const dims of dimensions) {
    const pg = await memorySearchDb();
    try {
      const vector = Array.from({ length: dims }, (_, i) => Math.fround(.5 + Math.sin(i * .17)));
      const prototypes = Array.from({ length: 32 }, (_, j) => Array.from({ length: dims }, (_, i) => Math.fround(.6 + Math.sin(i * (.17 + j * .0001)))));
      const similarities = prototypes.map(v => cosine(vector, v));
      await pg.exec("CREATE TABLE prototypes (id integer PRIMARY KEY, embedding real[])");
      for (let j = 0; j < prototypes.length; j++) await pg.query("INSERT INTO prototypes VALUES ($1,$2::real[])", [j, prototypes[j]]);
      for (const count of sizes) {
        await pg.exec("TRUNCATE memory_nodes, memory_embeddings");
        await pg.query(`INSERT INTO memory_nodes (id,session_id,title,content,layer,importance,salience,source,turn_to)
          SELECT ('10000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid, $1::uuid,
          'Memory ' || i, 'Synthetic benchmark fact ' || i,
          (ARRAY['semantic','episodic','chronicle','procedural'])[1+i%4],
          5+i%96, i%101, (ARRAY['state','seed','compaction','ai-semantic'])[1+(i/4)%4], i%120
          FROM generate_series(1,$2::integer) i`, [sessionId, count]);
        await pg.query(`INSERT INTO memory_embeddings
          SELECT n.id,n.id,n.session_id,$1,$2,'ready',chronicle_embedding_hash($1,$2,n.title,n.content),p.embedding
          FROM memory_nodes n JOIN prototypes p ON p.id = right(n.id::text,12)::bigint % 32`, [model, dims]);
        await pg.exec("ANALYZE memory_nodes; ANALYZE memory_embeddings");
        const query = buildMemorySearchQuery({ sessionId, model, dims, vector, currentTurn: 120 });
        const times: number[] = [];
        let result!: DatabaseSearchResult;
        for (let repeat = 0; repeat < 4; repeat++) {
          const started = performance.now();
          result = (await pg.query<DatabaseSearchResult>(query.text, query.values)).rows[0];
          if (repeat) times.push(performance.now() - started);
        }
        const expected = [];
        for (let i = 1; i <= count; i++) {
          const similarity = similarities[i % 32];
          if (similarity < .35) continue;
          const score = similarity * .55 + (5 + i % 96) / 100 * .2 + Math.max(0, 1 - (120 - i % 120) / 60) * .1 + (i % 101) / 100 * .05 + [1, .95, .85, .8][Math.floor(i / 4) % 4] * .1;
          expected.push({ id: `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`, layer: i % 4, score });
        }
        expected.sort((a,b) => b.score - a.score || a.id.localeCompare(b.id));
        const layerCounts = [0,0,0,0];
        const ids = expected.filter(n => ++layerCounts[n.layer] <= 4).slice(0,8).map(n => n.id);
        const parity = JSON.stringify(ids) === JSON.stringify(result.results.map(n => n.id));
        if (!parity || result.candidates !== expected.length) throw new Error(`Ranking parity failed for ${count}/${dims}`);
        times.sort((a,b) => a-b);
        console.log(JSON.stringify({ engine: "PGlite PostgreSQL/WASM, local, no network", dims, records: count, medianMs: +times[1].toFixed(1), resultBytes: Buffer.byteLength(JSON.stringify(result)), oldVectorBytesMinimum: count * dims * 4, results: result.results.length, candidates: result.candidates, parity }));
      }
    } finally { await pg.close(); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
