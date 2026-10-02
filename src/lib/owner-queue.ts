import type { AuthDatabase } from "./auth";

/** Rotate scheduler opportunities, not provider capacity. Job claims retain their own leases.
 * The global scheduler lock covers only selection + service recording; no provider work.
 */
export async function selectNextMemoryCampaign(database: AuthDatabase, ownerId?: string): Promise<{ id: string; ownerId: string } | undefined> {
  return database.transaction(async tx => {
    // Separate two-key namespace from owner admission and per-campaign one-key locks.
    await tx.query("SELECT pg_advisory_xact_lock(9144, 1)");
    const { rows } = await tx.query<{ id: string; ownerId: string }>(`
      SELECT s.id, s.owner_id AS "ownerId"
      FROM game_sessions s JOIN ai_settings a ON a.id = s.owner_id
      LEFT JOIN owner_queue_service q ON q.owner_id = s.owner_id
      CROSS JOIN LATERAL (
        SELECT min(work.due_at) AS due_at FROM (
          SELECT CASE WHEN j.status='processing' THEN j.lease_expires_at ELSE j.next_attempt_at END AS due_at
          FROM memory_jobs j WHERE j.session_id=s.id AND j.kind='semantic'
            AND a.use_live_ai AND a.semantic_extraction_enabled
            AND ((a.text_provider='gemini' AND jsonb_array_length(coalesce(a.keys,'[]'::jsonb))>0)
              OR (a.text_provider='openrouter' AND a.openrouter_key<>'')
              OR (a.text_provider='pollinations' AND a.pollinations_key<>'' AND (a.pollinations_key_expires_at IS NULL OR a.pollinations_key_expires_at>now())))
            AND ((j.status='pending' AND j.attempts<3 AND j.next_attempt_at<=now()) OR (j.status='processing' AND j.lease_expires_at<=now()))
          UNION ALL
          SELECT CASE WHEN e.status='processing' THEN e.lease_expires_at ELSE e.next_attempt_at END
          FROM memory_embeddings e WHERE e.session_id=s.id AND a.embeddings_enabled
            AND jsonb_array_length(coalesce(a.keys,'[]'::jsonb))>0 AND e.model=a.embedding_model AND e.dims=a.embedding_dims
            AND ((e.status='pending' AND e.attempts<3 AND e.next_attempt_at<=now()) OR (e.status='processing' AND e.lease_expires_at<=now()))
        ) work
      ) ready
      WHERE ($1::text IS NULL OR s.owner_id=$1) AND ready.due_at IS NOT NULL
      ORDER BY q.last_served_at ASC NULLS FIRST, ready.due_at, s.owner_id, s.id
      LIMIT 1`, [ownerId ?? null]);
    const next = rows[0];
    if (next) await tx.query(`INSERT INTO owner_queue_service(owner_id,last_served_at,served_count)
      VALUES ($1,clock_timestamp(),1) ON CONFLICT(owner_id) DO UPDATE
      SET last_served_at=clock_timestamp(),served_count=owner_queue_service.served_count+1`, [next.ownerId]);
    return next;
  });
}
