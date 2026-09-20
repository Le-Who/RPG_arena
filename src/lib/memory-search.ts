import { isValidVector } from "./vector";

export type RetrievedNode = { id: string; layer: string; category: string; title: string; content: string; importance: number; salience: number; source: string; sourceTurn: number | null; turnTo: number | null; evidence: string | null; similarity: number; score: number; why: string };
export type MemorySearchOptions = { sessionId: string; model: string; dims: number; currentTurn?: number; k?: number; perLayerCap?: number; minSimilarity?: number };
export type DatabaseSearchResult = { results: Omit<RetrievedNode, "why">[]; candidates: number };

/** Exact ranking in PostgreSQL. No vector or unbounded list leaves the database. */
export function buildMemorySearchQuery(opts: MemorySearchOptions & { vector: number[] }) {
  if (!Number.isInteger(opts.dims) || opts.dims < 128 || opts.dims > 3072 || !isValidVector(opts.vector, opts.dims)) throw new Error("INVALID_QUERY_VECTOR");
  const k = Math.max(1, Math.min(Number.isFinite(opts.k) ? Math.trunc(opts.k!) : 8, 20));
  const cap = Math.max(1, Math.min(Number.isFinite(opts.perLayerCap) ? Math.trunc(opts.perLayerCap!) : 4, 20));
  return {
    values: [opts.sessionId, opts.model, opts.dims, JSON.stringify(opts.vector), opts.minSimilarity ?? .35, opts.currentTurn ?? 0, cap, k],
    text: `WITH valid AS MATERIALIZED (
      SELECT n.id, n.layer, n.importance, n.salience, n.source, n.turn_to,
             chronicle_memory_vector(e.vector, $3::integer) AS embedding
      FROM memory_embeddings e JOIN memory_nodes n ON n.id = e.memory_node_id
      WHERE e.session_id = $1::uuid AND n.session_id = $1::uuid
        AND e.model = $2 AND e.dims = $3 AND e.status = 'ready'
        AND e.content_hash = chronicle_embedding_hash(e.model, e.dims, n.title, n.content)
    ), distances AS MATERIALIZED (
      SELECT id, layer, importance, salience, source, turn_to,
             1 - (embedding <=> $4::vector) AS similarity
      FROM valid WHERE embedding IS NOT NULL
    ), scored AS MATERIALIZED (
      SELECT id, layer, similarity,
        similarity * .55 + importance::double precision / 100 * .2
        + greatest(0, 1 - greatest(0, $6::double precision - coalesce(turn_to, 0)) / 60) * .1
        + salience::double precision / 100 * .05
        + CASE source WHEN 'state' THEN 1 WHEN 'seed' THEN .95 WHEN 'compaction' THEN .85 ELSE .8 END * .1 AS score
      FROM distances WHERE similarity >= $5::double precision AND similarity <= 1
    ), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY layer ORDER BY score DESC, id) AS layer_rank FROM scored
    ), selected AS (
      SELECT * FROM ranked WHERE layer_rank <= $7::integer ORDER BY score DESC, id LIMIT $8::integer
    )
    SELECT (SELECT count(*)::integer FROM scored) AS candidates,
      coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', n.id, 'layer', n.layer, 'category', n.category, 'title', n.title, 'content', n.content,
        'importance', n.importance, 'salience', n.salience, 'source', n.source,
        'sourceTurn', n.source_turn, 'turnTo', n.turn_to, 'evidence', n.evidence,
        'similarity', s.similarity, 'score', s.score
      ) ORDER BY s.score DESC, s.id) FROM selected s JOIN memory_nodes n ON n.id = s.id), '[]'::jsonb) AS results`,
  };
}

export function describeRetrievedNode(node: Omit<RetrievedNode, "why">): RetrievedNode {
  return { ...node, why: `Сходство ${Math.round(node.similarity * 100)}% · ${node.source} · ход ${node.sourceTurn ?? 1}` };
}
