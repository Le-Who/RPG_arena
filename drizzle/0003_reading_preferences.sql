-- v2.5: additive reading-comfort preferences.
-- Existing schema columns and character JSON are deliberately preserved.
ALTER TABLE "workspace_preferences" ADD COLUMN IF NOT EXISTS "reading" jsonb NOT NULL
  DEFAULT '{"textScale":"normal","measure":"normal","theme":"midnight","motion":"full"}'::jsonb;
