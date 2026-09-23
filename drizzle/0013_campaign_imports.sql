CREATE TABLE IF NOT EXISTS "campaign_imports" (
  "owner_id" text NOT NULL,
  "request_id" text NOT NULL,
  "input_hash" text NOT NULL,
  "campaign_id" uuid REFERENCES "game_sessions"("id") ON DELETE SET NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "campaign_imports_owner_request_pk" PRIMARY KEY("owner_id","request_id")
);
