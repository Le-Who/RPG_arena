ALTER TABLE "ai_settings" ADD COLUMN "text_provider" text DEFAULT 'gemini' NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_settings" ADD COLUMN "text_model" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_settings" ADD COLUMN "openrouter_key" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_settings" ADD COLUMN "pollinations_key" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_settings" ADD COLUMN "pollinations_key_expires_at" timestamp with time zone;
