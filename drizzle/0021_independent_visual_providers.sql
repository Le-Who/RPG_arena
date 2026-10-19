ALTER TABLE ai_settings ADD COLUMN visual_enabled boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE ai_settings ADD COLUMN visual_provider text NOT NULL DEFAULT 'pollinations' CHECK (visual_provider IN ('pollinations', 'openrouter'));
--> statement-breakpoint
ALTER TABLE ai_settings ADD COLUMN visual_model text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE ai_settings ADD COLUMN visual_endpoint text;
--> statement-breakpoint
UPDATE ai_settings SET visual_model = pollinations_image_model;
--> statement-breakpoint
ALTER TABLE ai_settings ADD CONSTRAINT visual_openrouter_personal_only CHECK (visual_provider <> 'openrouter' OR visual_account_source = 'personal');
--> statement-breakpoint
ALTER TABLE scene_visuals ADD COLUMN endpoint text;
--> statement-breakpoint
ALTER TABLE scene_visuals ADD COLUMN output_format text CHECK (output_format IN ('png', 'jpeg', 'webp'));
--> statement-breakpoint
ALTER TABLE scene_visuals ADD CONSTRAINT scene_visual_openrouter_personal_only CHECK (provider <> 'openrouter' OR account_source = 'personal');
