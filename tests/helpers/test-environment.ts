// The unit suite owns synthetic PGlite/provider fixtures. Never inherit a user's DB or credentials.
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/chronicle_test";
for (const name of [
  "GEMINI_API_KEY", "GEMINI_API_KEYS", "OPENROUTER_API_KEY", "TYPESAFE_API_KEY",
  "NARRATIVE_ADMIN_OPENROUTER_API_KEY", "NARRATIVE_ADMIN_TYPESAFE_API_KEY",
  "CHRONICLE_SECRET_KEYS", "CHRONICLE_SECRET_ACTIVE_KEY", "CHRONICLE_ALLOW_LEGACY_PLAINTEXT",
  "CHRONICLE_ADMIN_ACCOUNT_IDS",
]) delete process.env[name];
