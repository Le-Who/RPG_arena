CREATE TABLE IF NOT EXISTS "visual_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"model" text NOT NULL,
	"updated_by" uuid REFERENCES "accounts"("id") ON DELETE SET NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visual_settings_singleton" CHECK ("id" = 1)
);
