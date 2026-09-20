CREATE TABLE narrative_attempts (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  turn_number integer NOT NULL,
  outcome text NOT NULL DEFAULT 'running',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX idx_narrative_attempts_session_created ON narrative_attempts(session_id, created_at DESC, id);
--> statement-breakpoint
CREATE INDEX idx_narrative_attempts_created ON narrative_attempts(created_at);
