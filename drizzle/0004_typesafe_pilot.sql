-- Optional Jev shadow verification for normalized semantic-memory facts.
ALTER TABLE "ai_settings" ADD COLUMN IF NOT EXISTS "typesafe_key" text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE "ai_settings" ADD COLUMN IF NOT EXISTS "typesafe_pilot_enabled" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "memory_jobs" ADD COLUMN IF NOT EXISTS "typesafe_report" jsonb;
--> statement-breakpoint
UPDATE "memory_jobs" SET "typesafe_report" = NULL WHERE "typesafe_report" = 'null'::jsonb;
--> statement-breakpoint
ALTER TABLE "memory_jobs" ALTER COLUMN "typesafe_report" DROP DEFAULT;
