ALTER TABLE ai_settings ADD COLUMN keys_shared_project boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE ai_settings ADD COLUMN daily_embedding_limit integer NOT NULL DEFAULT 5000;
--> statement-breakpoint
-- Existing rows remain false. New reserved attempts mark telemetry true, including when enforcement is off.
ALTER TABLE token_logs ADD COLUMN quota_reserved boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE INDEX idx_token_logs_legacy_quota ON token_logs(owner_id, model, created_at) WHERE NOT quota_reserved;
--> statement-breakpoint
CREATE TABLE model_call_quotas (
  owner_id text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('generation','embedding')),
  model text NOT NULL,
  day date NOT NULL,
  attempts bigint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  legacy_used bigint NOT NULL DEFAULT 0 CHECK (legacy_used >= 0),
  PRIMARY KEY (owner_id, scope, model, day)
);
-- Legacy carry is reconciled atomically on admission using the configured timezone and database UTC logs.
