-- v2.1: leased, durable embedding outbox and local workspace preferences.
ALTER TABLE "memory_embeddings" ADD COLUMN IF NOT EXISTS "lease_token" uuid;
--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamp;
--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_preferences" (
  "id" text PRIMARY KEY DEFAULT 'local' NOT NULL,
  "display_name" text DEFAULT 'Искатель историй' NOT NULL,
  "favorites" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
