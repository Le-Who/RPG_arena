import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { sealSecret, secretContext, type SecretKeyring } from "../src/lib/secret-vault";

test("getAIConfig decodes Gemini keys without opening unrelated credentials", async () => {
  const ring: SecretKeyring = { active: "ai-v1", keys: { "ai-v1": Buffer.alloc(32, 21).toString("base64") } };
  process.env.CHRONICLE_SECRET_ACTIVE_KEY = ring.active;
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify(ring.keys);
  const { pool } = await import("../src/db");
  const { getAIConfig } = await import("../src/lib/ai-settings");
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE ai_settings(
    id text PRIMARY KEY, keys jsonb DEFAULT '[]'::jsonb, routing_profile text NOT NULL DEFAULT 'balanced',
    narration_model text NOT NULL DEFAULT 'gemini-3.5-flash-lite', custom_action_model text NOT NULL DEFAULT 'gemini-3.8-flash',
    compaction_model text NOT NULL DEFAULT 'gemini-3.8-flash', fast_task_model text NOT NULL DEFAULT 'gemini-3.5-flash-lite',
    use_live_ai boolean NOT NULL DEFAULT false, daily_flash_limit integer NOT NULL DEFAULT 20, daily_lite_limit integer NOT NULL DEFAULT 500,
    enforce_limits boolean NOT NULL DEFAULT true, embeddings_enabled boolean NOT NULL DEFAULT true,
    keys_shared_project boolean NOT NULL DEFAULT true, daily_embedding_limit integer NOT NULL DEFAULT 5000,
    embedding_model text NOT NULL DEFAULT 'gemini-embedding-2', embedding_dims integer NOT NULL DEFAULT 768,
    semantic_extraction_enabled boolean NOT NULL DEFAULT true, typesafe_key text NOT NULL DEFAULT '',
    typesafe_pilot_enabled boolean NOT NULL DEFAULT false, narrative_guard_enabled boolean NOT NULL DEFAULT true,
    narrative_guard_provider text NOT NULL DEFAULT 'openrouter', narrative_guard_key text NOT NULL DEFAULT '', updated_at timestamp NOT NULL DEFAULT now()
  )`);
  await pg.query("INSERT INTO ai_settings(id,keys,use_live_ai,typesafe_key,narrative_guard_key) VALUES ($1,$2::jsonb,true,$3,$4)", [
    "owner-a",
    JSON.stringify([sealSecret("gemini-live-key", secretContext("owner-a", "gemini"), ring)]),
    "enc:v1:missing:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AA",
    "enc:v2:unknown:AA:AA:AA",
  ]);
  const run = async (query: string | { text: string; values?: unknown[]; rowMode?: string }, values?: unknown[]) => {
    const config = typeof query === "string" ? { text: query, values } : { ...query, values: values ?? query.values };
    const result = await pg.query<Record<string, unknown>>(config.text, config.values);
    const normalize = (value: unknown) => value instanceof Date ? value.toISOString() : value;
    return { ...result, rows: result.rows.map(row => config.rowMode === "array" ? result.fields.map(field => normalize(row[field.name])) : Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalize(value)]))) };
  };
  const queryMock = mock.method(pool, "query", run as never);
  try {
    const config = await getAIConfig("owner-a");
    assert.deepEqual(config.keys, ["gemini-live-key"]);
    assert.equal(config.canUseLive, true);
  } finally {
    queryMock.mock.restore();
    await pg.close();
    delete process.env.CHRONICLE_SECRET_ACTIVE_KEY;
    delete process.env.CHRONICLE_SECRET_KEYS;
  }
});
