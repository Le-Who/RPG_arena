-- Scheduler rotation metadata; existing job leases remain authoritative.
CREATE TABLE IF NOT EXISTS "owner_queue_service" (
  "owner_id" text PRIMARY KEY NOT NULL,
  "last_served_at" timestamp with time zone DEFAULT now() NOT NULL,
  "served_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "owner_queue_service_served_idx" ON "owner_queue_service" ("last_served_at");
