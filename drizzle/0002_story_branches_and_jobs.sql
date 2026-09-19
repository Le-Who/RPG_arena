ALTER TABLE "game_sessions" ADD COLUMN IF NOT EXISTS "branch_origin" jsonb DEFAULT 'null'::jsonb;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "turn_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "game_sessions"("id") ON DELETE CASCADE,
  "request_id" text NOT NULL, "input_hash" text NOT NULL, "action" text NOT NULL, "is_free" boolean NOT NULL, "base_turn" integer NOT NULL,
  "status" text NOT NULL, "stage" text NOT NULL DEFAULT 'context', "lease_token" uuid, "lease_expires_at" timestamp,
  "dice" jsonb, "result" jsonb, "error" text, "attempts" integer NOT NULL DEFAULT 1,
  "created_at" timestamp NOT NULL DEFAULT now(), "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_turn_request_key" ON "turn_requests"("session_id", "request_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_running_turn_session" ON "turn_requests"("session_id") WHERE "status" = 'running';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_turn_requests_status_updated" ON "turn_requests"("status", "updated_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "game_sessions"("id") ON DELETE CASCADE,
  "turn_number" integer NOT NULL, "kind" text NOT NULL DEFAULT 'semantic', "payload" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending', "attempts" integer NOT NULL DEFAULT 0,
  "lease_token" uuid, "lease_expires_at" timestamp, "next_attempt_at" timestamp NOT NULL DEFAULT now(), "error" text,
  "facts_count" integer NOT NULL DEFAULT 0, "created_at" timestamp NOT NULL DEFAULT now(), "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_memory_job_turn_kind" ON "memory_jobs"("session_id", "turn_number", "kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memory_jobs_ready" ON "memory_jobs"("status", "next_attempt_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign_checkpoints" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "session_id" uuid NOT NULL REFERENCES "game_sessions"("id") ON DELETE CASCADE,
  "title" text NOT NULL, "turn_number" integer NOT NULL, "request_id" text NOT NULL, "snapshot" jsonb NOT NULL, "checksum" text NOT NULL, "summary" jsonb NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_checkpoints_session_turn" ON "campaign_checkpoints"("session_id", "turn_number");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_checkpoint_request" ON "campaign_checkpoints"("session_id", "request_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "checkpoint_forks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "checkpoint_id" uuid NOT NULL REFERENCES "campaign_checkpoints"("id") ON DELETE CASCADE,
  "request_id" text NOT NULL, "input_hash" text NOT NULL, "branch_id" uuid REFERENCES "game_sessions"("id") ON DELETE SET NULL, "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_checkpoint_fork_request" ON "checkpoint_forks"("checkpoint_id", "request_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "worker_heartbeats" (
  "id" text PRIMARY KEY NOT NULL, "status" text NOT NULL, "last_seen_at" timestamp NOT NULL DEFAULT now(), "report" jsonb
);
