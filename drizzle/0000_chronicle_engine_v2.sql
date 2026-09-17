-- Chronicle Engine — базовая схема v2 (идемпотентная).
-- Безопасна и для чистой БД, и для апгрейда с v1: CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- FK через guarded DO-блоки. Применяется ровно один раз через drizzle migrator (ledger __drizzle_migrations),
-- повторный запуск также безопасен.
CREATE TABLE IF NOT EXISTS "ai_settings" (
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
	"enforce_limits" boolean DEFAULT true NOT NULL,
	"embeddings_enabled" boolean DEFAULT true NOT NULL,
	"embedding_model" text DEFAULT 'gemini-embedding-2' NOT NULL,
	"embedding_dims" integer DEFAULT 768 NOT NULL,
	"semantic_extraction_enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_settings" ADD COLUMN IF NOT EXISTS "enforce_limits" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_settings" ADD COLUMN IF NOT EXISTS "embeddings_enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_settings" ADD COLUMN IF NOT EXISTS "embedding_model" text DEFAULT 'gemini-embedding-2' NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_settings" ADD COLUMN IF NOT EXISTS "embedding_dims" integer DEFAULT 768 NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_settings" ADD COLUMN IF NOT EXISTS "semantic_extraction_enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "game_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"scenario_id" text DEFAULT 'custom' NOT NULL,
	"scenario_title" text DEFAULT 'Своя история' NOT NULL,
	"scenario_prompt" text DEFAULT '' NOT NULL,
	"campaign_mode" text DEFAULT 'preset' NOT NULL,
	"rules_profile" text DEFAULT 'd20' NOT NULL,
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
ALTER TABLE "game_sessions" ADD COLUMN IF NOT EXISTS "campaign_mode" text DEFAULT 'preset' NOT NULL;
--> statement-breakpoint
ALTER TABLE "game_sessions" ADD COLUMN IF NOT EXISTS "rules_profile" text DEFAULT 'd20' NOT NULL;
--> statement-breakpoint
ALTER TABLE "game_sessions" ADD COLUMN IF NOT EXISTS "last_compact_turn" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "game_sessions" SET "campaign_mode" = 'free' WHERE "scenario_id" = 'custom' AND "campaign_mode" = 'preset';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "game_turns" (
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
	"request_id" text,
	"state_changes" jsonb DEFAULT 'null'::jsonb,
	"context_meta" jsonb DEFAULT 'null'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "game_turns" ADD COLUMN IF NOT EXISTS "request_id" text;
--> statement-breakpoint
ALTER TABLE "game_turns" ADD COLUMN IF NOT EXISTS "state_changes" jsonb DEFAULT 'null'::jsonb;
--> statement-breakpoint
ALTER TABLE "game_turns" ADD COLUMN IF NOT EXISTS "context_meta" jsonb DEFAULT 'null'::jsonb;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'misc' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"equipped" boolean DEFAULT false NOT NULL,
	"power" integer DEFAULT 0 NOT NULL,
	"icon" text DEFAULT '🎒' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memory_node_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"model" text NOT NULL,
	"dims" integer DEFAULT 768 NOT NULL,
	"content_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text DEFAULT '',
	"vector" real[],
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"relation" text DEFAULT 'relates' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_nodes" (
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
	"source" text DEFAULT 'heuristic' NOT NULL,
	"source_turn" integer,
	"content_hash" text,
	"entity_key" text,
	"confidence" real DEFAULT 1 NOT NULL,
	"evidence" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_nodes" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'heuristic' NOT NULL;
--> statement-breakpoint
ALTER TABLE "memory_nodes" ADD COLUMN IF NOT EXISTS "source_turn" integer;
--> statement-breakpoint
ALTER TABLE "memory_nodes" ADD COLUMN IF NOT EXISTS "content_hash" text;
--> statement-breakpoint
ALTER TABLE "memory_nodes" ADD COLUMN IF NOT EXISTS "entity_key" text;
--> statement-breakpoint
ALTER TABLE "memory_nodes" ADD COLUMN IF NOT EXISTS "confidence" real DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "memory_nodes" ADD COLUMN IF NOT EXISTS "evidence" text;
--> statement-breakpoint
ALTER TABLE "memory_nodes" ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "npcs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"relation" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'alive' NOT NULL,
	"last_seen_turn" integer DEFAULT 0 NOT NULL,
	"last_location" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"is_main" boolean DEFAULT false NOT NULL,
	"updated_turn" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scene_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"location_name" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'intact' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"interactable" boolean DEFAULT true NOT NULL,
	"updated_turn" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "token_logs" (
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
CREATE TABLE IF NOT EXISTS "world_locations" (
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
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_turns_session_id_game_sessions_id_fk') THEN
    ALTER TABLE "game_turns" ADD CONSTRAINT "game_turns_session_id_game_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_items_session_id_game_sessions_id_fk') THEN
    ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_session_id_game_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_embeddings_memory_node_id_memory_nodes_id_fk') THEN
    ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_memory_node_id_memory_nodes_id_fk" FOREIGN KEY ("memory_node_id") REFERENCES "public"."memory_nodes"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_embeddings_session_id_game_sessions_id_fk') THEN
    ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_session_id_game_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_links_from_id_memory_nodes_id_fk') THEN
    ALTER TABLE "memory_links" ADD CONSTRAINT "memory_links_from_id_memory_nodes_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."memory_nodes"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_links_to_id_memory_nodes_id_fk') THEN
    ALTER TABLE "memory_links" ADD CONSTRAINT "memory_links_to_id_memory_nodes_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."memory_nodes"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_nodes_session_id_game_sessions_id_fk') THEN
    ALTER TABLE "memory_nodes" ADD CONSTRAINT "memory_nodes_session_id_game_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_nodes_parent_id_memory_nodes_id_fk') THEN
    ALTER TABLE "memory_nodes" ADD CONSTRAINT "memory_nodes_parent_id_memory_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."memory_nodes"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'npcs_session_id_game_sessions_id_fk') THEN
    ALTER TABLE "npcs" ADD CONSTRAINT "npcs_session_id_game_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quests_session_id_game_sessions_id_fk') THEN
    ALTER TABLE "quests" ADD CONSTRAINT "quests_session_id_game_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scene_objects_session_id_game_sessions_id_fk') THEN
    ALTER TABLE "scene_objects" ADD CONSTRAINT "scene_objects_session_id_game_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'token_logs_session_id_game_sessions_id_fk') THEN
    ALTER TABLE "token_logs" ADD CONSTRAINT "token_logs_session_id_game_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'world_locations_session_id_game_sessions_id_fk') THEN
    ALTER TABLE "world_locations" ADD CONSTRAINT "world_locations_session_id_game_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."game_sessions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_game_turns_session_id" ON "game_turns" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_game_turns_session_role_turn" ON "game_turns" USING btree ("session_id","role","turn_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_game_turns_session_turn_desc" ON "game_turns" USING btree ("session_id","turn_number");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_game_turns_session_request" ON "game_turns" USING btree ("session_id","request_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inventory_items_session_id" ON "inventory_items" USING btree ("session_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_memory_embeddings_node" ON "memory_embeddings" USING btree ("memory_node_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memory_embeddings_session_status" ON "memory_embeddings" USING btree ("session_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memory_nodes_session_importance" ON "memory_nodes" USING btree ("session_id","importance");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memory_nodes_session_turnto" ON "memory_nodes" USING btree ("session_id","turn_to");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memory_nodes_session_hash" ON "memory_nodes" USING btree ("session_id","content_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memory_nodes_session_entity" ON "memory_nodes" USING btree ("session_id","entity_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_npcs_session_key" ON "npcs" USING btree ("session_id","key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_quests_session_key" ON "quests" USING btree ("session_id","key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_scene_objects_session_key" ON "scene_objects" USING btree ("session_id","key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_token_logs_session_id" ON "token_logs" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_token_logs_created_at" ON "token_logs" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_token_logs_model_created" ON "token_logs" USING btree ("model","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_world_locations_session_id" ON "world_locations" USING btree ("session_id");
