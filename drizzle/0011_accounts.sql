CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  login text NOT NULL UNIQUE,
  profile_id text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE account_sessions (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX account_sessions_account_idx ON account_sessions(account_id);
--> statement-breakpoint
CREATE TABLE consumed_guest_profiles (
  profile_id text PRIMARY KEY,
  account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  consumed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE auth_rate_limits (
  bucket text PRIMARY KEY,
  attempts integer NOT NULL,
  expires_at timestamptz NOT NULL
);
--> statement-breakpoint
-- No automatic expiry: late provider work must never overlap an ownership transfer.
CREATE TABLE owner_activity (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX owner_activity_owner_idx ON owner_activity(owner_id);
