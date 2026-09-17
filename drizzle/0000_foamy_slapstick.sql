CREATE TABLE "ai_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"keys" jsonb DEFAULT '[]'::jsonb,
	"routing_profile" text DEFAULT 'balanced' NOT NULL,
	"narration_model" text DEFAULT 'gemini-3.5-flash-lite' NOT NULL,
	"custom_action_model" text DEFAULT 'gemini-3.8-flash' NOT NULL,
	"compaction_model" text DEFAULT 'gemini-3.8-flash' NOT NULL,
	"fast_task_model" text DEFAULT 'gemini-3.5-flash-lite' NOT NULL,
	"primary_model" text DEFAULT 'gemini-3.5-flash-lite' NOT NULL,
	"fallback_chain" jsonb DEFAULT '["gemini-3.5-flash-lite","gemini-3.8-flash","gemini-3.7-flash","gemini-3.6-flash"]'::jsonb,
	"use_live_ai" boolean DEFAULT false NOT NULL,
	"daily_flash_limit" integer DEFAULT 20 NOT NULL,
	"daily_lite_limit" integer DEFAULT 500 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"scenario_id" text DEFAULT 'custom' NOT NULL,
	"scenario_title" text DEFAULT 'Своя история' NOT NULL,
	"scenario_prompt" text DEFAULT '' NOT NULL,
	"character" jsonb NOT NULL,
	"world_state" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"context_tokens_estimate" integer DEFAULT 0 NOT NULL,
	"last_compact_turn" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"turn_number" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"choices" jsonb DEFAULT '[]'::jsonb,
	"dice" jsonb DEFAULT 'null'::jsonb,
	"model_used" text,
	"task_type" text,
	"prompt_tokens" integer DEFAULT 0,
	"completion_tokens" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'misc' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"equipped" boolean DEFAULT false NOT NULL,
	"power" integer DEFAULT 0 NOT NULL,
	"icon" text DEFAULT '🎒' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"relation" text DEFAULT 'relates' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"layer" text NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"importance" real DEFAULT 50 NOT NULL,
	"salience" real DEFAULT 50 NOT NULL,
	"tokens_estimate" integer DEFAULT 0 NOT NULL,
	"parent_id" uuid,
	"turn_from" integer DEFAULT 0,
	"turn_to" integer DEFAULT 0,
	"access_count" integer DEFAULT 0 NOT NULL,
	"last_accessed_at" timestamp DEFAULT now(),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid,
	"model" text NOT NULL,
	"task_type" text NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"success" boolean DEFAULT true NOT NULL,
	"error" text DEFAULT '',
	"key_index" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "world_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"x" integer DEFAULT 0 NOT NULL,
	"y" integer DEFAULT 0 NOT NULL,
	"discovered" boolean DEFAULT false NOT NULL,
	"current" boolean DEFAULT false NOT NULL,
	"danger" integer DEFAULT 10 NOT NULL,
	"icon" text DEFAULT '📍' NOT NULL,
	"connected_to" jsonb DEFAULT '[]'::jsonb
);
--> statement-breakpoint
ALTER TABLE "game_turns" ADD CONSTRAINT "game_turns_session_id_game_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_session_id_game_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_links" ADD CONSTRAINT "memory_links_from_id_memory_nodes_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."memory_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_links" ADD CONSTRAINT "memory_links_to_id_memory_nodes_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."memory_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_nodes" ADD CONSTRAINT "memory_nodes_session_id_game_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_nodes" ADD CONSTRAINT "memory_nodes_parent_id_memory_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."memory_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_logs" ADD CONSTRAINT "token_logs_session_id_game_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_locations" ADD CONSTRAINT "world_locations_session_id_game_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE cascade ON UPDATE no action;