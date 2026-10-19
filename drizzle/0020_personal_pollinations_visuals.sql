ALTER TABLE ai_settings ADD COLUMN visual_account_source text NOT NULL DEFAULT 'application' CHECK (visual_account_source IN ('application', 'personal'));
--> statement-breakpoint
ALTER TABLE ai_settings ADD COLUMN pollinations_image_model text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE scene_visuals ADD COLUMN account_source text NOT NULL DEFAULT 'application' CHECK (account_source IN ('application', 'personal'));
