CREATE TABLE IF NOT EXISTS "visual_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL REFERENCES "game_sessions"("id") ON DELETE cascade,
	"subject_key" text NOT NULL,
	"subject_name" text NOT NULL,
	"passport" text DEFAULT '' NOT NULL,
	"seed" integer NOT NULL,
	"reference_visual_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_visual_identities_subject" ON "visual_identities" ("session_id","subject_key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scene_visuals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL REFERENCES "game_sessions"("id") ON DELETE cascade,
	"owner_id" text,
	"kind" text NOT NULL,
	"subject_key" text DEFAULT 'scene' NOT NULL,
	"turn_number" integer DEFAULT 0 NOT NULL,
	"caption" text DEFAULT '' NOT NULL,
	"prompt" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"seed" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"mime_type" text,
	"image" bytea,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_scene_visuals_session" ON "scene_visuals" ("session_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_scene_visuals_owner_day" ON "scene_visuals" ("owner_id","created_at");
