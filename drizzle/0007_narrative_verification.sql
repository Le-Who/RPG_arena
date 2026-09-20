ALTER TABLE "ai_settings" ADD COLUMN "narrative_guard_enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_settings" ADD COLUMN "narrative_guard_provider" text DEFAULT 'openrouter' NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_settings" ADD COLUMN "narrative_guard_key" text DEFAULT '' NOT NULL;
