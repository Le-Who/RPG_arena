import { createHash } from "node:crypto";

/** Original turn text is evidence, not an unconditional assertion that its prose is true. */
export type NarrativeEvidence = {
  completeHistory: false; truncated: boolean;
  sources: { id: string; turn: number; role: string; text: string; sha256: string; truncated: boolean;
    authority: "intention" | "legacy_narration" | "disputed_narration" | "verified_narration";
    acceptedChanges: unknown;
  }[];
};

export function buildNarrativeEvidenceQuery(input: { sessionId: string; beforeTurn: number; action: string; sourceTurns: number[] }) {
  if (!Number.isSafeInteger(input.beforeTurn) || input.beforeTurn < 1) throw new Error("INVALID_EVIDENCE_TURN");
  const terms = [...new Set((input.action.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []))].slice(0, 20);
  const sourceTurns = [...new Set(input.sourceTurns.filter(n => Number.isSafeInteger(n) && n > 0 && n < input.beforeTurn))].slice(0, 16);
  return {
    text: `WITH candidates AS (
      SELECT turn_number,
        ts_rank_cd(evidence_search, websearch_to_tsquery('russian', $3)) AS relevance,
        turn_number = ANY($4::integer[]) AS referenced
      FROM game_turns WHERE session_id = $1 AND turn_number < $2 AND role IN ('player','narrator')
        AND evidence_search @@ websearch_to_tsquery('russian', $3)
      UNION ALL
      SELECT turn_number, 0::real AS relevance, turn_number = ANY($4::integer[]) AS referenced
      FROM game_turns WHERE session_id = $1 AND turn_number < $2 AND role IN ('player','narrator')
        AND (turn_number = ANY($4::integer[]) OR turn_number >= $2 - 4)
    ), chosen AS (
      SELECT turn_number, max(relevance) AS relevance, bool_or(referenced) AS referenced
      FROM candidates GROUP BY turn_number
      ORDER BY bool_or(referenced) DESC, max(relevance) DESC, turn_number DESC LIMIT 20
    )
    SELECT s.id, s.turn_number, s.role, s.content, s.state_changes,
      (s.context_meta->'narrativeVerification') - 'evidence' AS verification
    FROM game_turns s JOIN chosen c USING(turn_number)
    WHERE s.session_id = $1 AND s.turn_number < $2 AND s.role IN ('player','narrator')
    ORDER BY c.referenced DESC, c.relevance DESC, s.turn_number ASC, s.role ASC LIMIT 40`,
    values: [input.sessionId, input.beforeTurn, terms.join(" OR "), sourceTurns],
  };
}

export function snapshotNarrativeEvidence(rows: unknown[]): NarrativeEvidence {
  const sources: NarrativeEvidence["sources"] = [];
  let remaining = 32000, truncated = rows.length > 40;
  for (const value of rows.slice(0, 40)) {
    if (!value || typeof value !== "object") throw new Error("INVALID_EVIDENCE_ROW");
    const row = value as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.content !== "string" || !Number.isSafeInteger(row.turn_number) || !["player", "narrator"].includes(String(row.role))) throw new Error("INVALID_EVIDENCE_ROW");
    if (remaining <= 0) { truncated = true; break; }
    const text = row.content.slice(0, Math.min(6000, remaining));
    remaining -= text.length;
    const clipped = text.length !== row.content.length;
    truncated ||= clipped;
    // Detach from mutable DB rows; retain accepted deltas beside any disputed prose.
    const acceptedChanges: unknown = row.state_changes == null ? null : JSON.parse(JSON.stringify(row.state_changes));
    const changes = acceptedChanges as { rejected?: unknown[] } | null;
    const disputed = Array.isArray(changes?.rejected) && changes.rejected.length > 0;
    const hash = createHash("sha256").update(row.content).digest("hex");
    const verification = row.verification as { version?: unknown; textSha256?: unknown; checks?: { status?: unknown }[];
      reviews?: { attempt?: unknown; result?: { status?: unknown } }[] } | null;
    // A corrected draft may have an initial rejection; only its final verified result applies.
    const checks = Array.isArray(verification?.checks) ? verification.checks : [];
    const finalReview = Array.isArray(verification?.reviews) ? verification.reviews.at(-1) : undefined;
    const verified = verification?.version === 1 && verification.textSha256 === hash && checks.length > 0
      && (checks.at(-1)?.status === "verified" || (checks.at(-1)?.status === "uncertain"
        && finalReview?.attempt === checks.length - 1 && finalReview.result?.status === "verified"));
    sources.push({ id: row.id, turn: row.turn_number as number, role: String(row.role), text,
      sha256: hash, truncated: clipped,
      authority: row.role === "player" ? "intention" : verified ? "verified_narration" : disputed ? "disputed_narration" : "legacy_narration", acceptedChanges });
  }
  return { completeHistory: false, truncated, sources };
}
