CREATE TABLE "visual_quota_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quota_scope" text NOT NULL,
	"visual_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_visual_quota_scope_created" ON "visual_quota_reservations" ("quota_scope","created_at");
--> statement-breakpoint
-- Preserve quota consumed by visuals that existed before this durable ledger was introduced.
INSERT INTO "visual_quota_reservations" ("quota_scope", "visual_id", "created_at")
SELECT CASE WHEN sessions."owner_id" IS NOT NULL THEN 'owner:' || sessions."owner_id" ELSE 'session:' || visuals."session_id"::text END,
       visuals."id",
       visuals."created_at"
FROM "scene_visuals" visuals
JOIN "game_sessions" sessions ON sessions."id" = visuals."session_id";
