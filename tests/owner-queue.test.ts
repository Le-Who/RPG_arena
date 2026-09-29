import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import type { AuthDatabase } from "../src/lib/auth";
import { selectNextMemoryCampaign } from "../src/lib/owner-queue";

test("scheduler rotates ready owners, respects scope and ignores in-flight and incompatible work", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE TABLE game_sessions(id text PRIMARY KEY, owner_id text);
      CREATE TABLE ai_settings(id text PRIMARY KEY, use_live_ai boolean DEFAULT true, semantic_extraction_enabled boolean DEFAULT true, text_provider text DEFAULT 'gemini', keys jsonb DEFAULT '["synthetic"]', openrouter_key text DEFAULT '', pollinations_key text DEFAULT '', pollinations_key_expires_at timestamptz, embeddings_enabled boolean DEFAULT true, embedding_model text DEFAULT 'current', embedding_dims integer DEFAULT 3);
      CREATE TABLE memory_jobs(session_id text, status text DEFAULT 'pending', next_attempt_at timestamptz DEFAULT now(), lease_expires_at timestamptz, kind text DEFAULT 'semantic', attempts integer DEFAULT 0);
      CREATE TABLE memory_embeddings(session_id text, status text DEFAULT 'pending', next_attempt_at timestamptz DEFAULT now(), lease_expires_at timestamptz, model text DEFAULT 'current', dims integer DEFAULT 3, attempts integer DEFAULT 0);
      INSERT INTO ai_settings(id) VALUES ('a'),('b'),('disabled');
      UPDATE ai_settings SET use_live_ai=false,embeddings_enabled=false WHERE id='disabled';
      INSERT INTO game_sessions VALUES ('a-old','a'),('a-ready','a'),('b-ready','b'),('off','disabled');
      INSERT INTO memory_jobs(session_id,status,next_attempt_at,lease_expires_at) VALUES ('a-old','processing',now()-interval '1 day',now()+interval '1 hour');
      INSERT INTO memory_jobs(session_id,next_attempt_at) VALUES ('a-ready',now()-interval '1 hour'),('b-ready',now()),('off',now()-interval '1 day');
      INSERT INTO memory_embeddings(session_id,model,next_attempt_at) VALUES ('a-old','obsolete',now()-interval '1 day');`);
    await pg.exec(await readFile(new URL("../drizzle/0017_owner_queue_fairness.sql", import.meta.url), "utf8"));
    // PGlite serializes transactions on one connection. This verifies scheduling SQL,
    // not PostgreSQL lock contention between independent processes.
    const statements: string[] = [];
    const database: AuthDatabase = { query: (sql, values) => pg.query(sql, values), transaction: fn => pg.transaction(tx => fn({ query: (sql, values) => { statements.push(sql); return tx.query(sql, values); } })) };
    assert.equal((await selectNextMemoryCampaign(database))?.id, "a-ready");
    assert.equal((await selectNextMemoryCampaign(database))?.id, "b-ready");
    assert.equal((await selectNextMemoryCampaign(database))?.id, "a-ready");
    assert.equal((await selectNextMemoryCampaign(database, "b"))?.id, "b-ready");
    assert.equal(await selectNextMemoryCampaign(database, "disabled"), undefined);
    assert.match(statements[0], /pg_advisory_xact_lock/);
    assert.equal((await pg.query<{ n: number }>("SELECT sum(served_count)::int n FROM owner_queue_service")).rows[0].n, 4);
    await pg.exec("UPDATE memory_jobs SET status='completed'; INSERT INTO memory_embeddings(session_id) VALUES ('b-ready');");
    assert.equal((await selectNextMemoryCampaign(database))?.id, "b-ready");
  } finally { await pg.close(); }
});
