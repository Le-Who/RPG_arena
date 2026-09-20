-- Compute once per write; old turns are backfilled by PostgreSQL.
ALTER TABLE game_turns ADD COLUMN evidence_search tsvector
  GENERATED ALWAYS AS (to_tsvector('russian'::regconfig, content)) STORED;
--> statement-breakpoint
CREATE INDEX idx_game_turns_evidence_search ON game_turns USING gin (evidence_search);
