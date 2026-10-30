ALTER TABLE ai_settings ADD COLUMN openai_key text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE ai_settings DROP CONSTRAINT ai_settings_visual_provider_check;
--> statement-breakpoint
ALTER TABLE ai_settings ADD CONSTRAINT ai_settings_visual_provider_check CHECK (visual_provider IN ('pollinations', 'openrouter', 'openai'));
--> statement-breakpoint
ALTER TABLE ai_settings ADD CONSTRAINT visual_openai_personal_only CHECK (visual_provider <> 'openai' OR visual_account_source = 'personal');
--> statement-breakpoint
ALTER TABLE scene_visuals ADD CONSTRAINT scene_visual_openai_personal_only CHECK (provider <> 'openai' OR account_source = 'personal');
