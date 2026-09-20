ALTER TABLE game_sessions ADD COLUMN owner_id text;
--> statement-breakpoint
ALTER TABLE game_sessions ADD COLUMN visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public'));
--> statement-breakpoint
CREATE INDEX idx_game_sessions_owner ON game_sessions(owner_id, updated_at);
--> statement-breakpoint
CREATE INDEX idx_game_sessions_public ON game_sessions(updated_at) WHERE visibility = 'public' AND owner_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE token_logs ADD COLUMN owner_id text;
--> statement-breakpoint
CREATE INDEX idx_token_logs_owner_created ON token_logs(owner_id, created_at);
