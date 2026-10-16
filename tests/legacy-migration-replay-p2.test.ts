import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { applyMigrations } from "../scripts/lib/apply-migrations";

// A supported v1 database: omit only columns which 0000 explicitly adds to
// existing tables. Workspace preferences may already exist before journal 0001.
// These fixtures are independent of current Drizzle table definitions.
const legacySchema = `
CREATE TABLE ai_settings (
  id text PRIMARY KEY, keys jsonb, routing_profile text NOT NULL,
  narration_model text NOT NULL, custom_action_model text NOT NULL,
  compaction_model text NOT NULL, fast_task_model text NOT NULL, primary_model text NOT NULL,
  fallback_chain jsonb, use_live_ai boolean NOT NULL, daily_flash_limit integer NOT NULL,
  daily_lite_limit integer NOT NULL, updated_at timestamp NOT NULL
);
CREATE TABLE game_sessions (
  id uuid PRIMARY KEY, title text NOT NULL, scenario_id text NOT NULL,
  scenario_title text NOT NULL, scenario_prompt text NOT NULL, character jsonb NOT NULL,
  world_state jsonb NOT NULL, status text NOT NULL, turn_count integer NOT NULL,
  context_tokens_estimate integer NOT NULL, created_at timestamp NOT NULL, updated_at timestamp NOT NULL
);
CREATE TABLE game_turns (
  id uuid PRIMARY KEY, session_id uuid NOT NULL, turn_number integer NOT NULL,
  role text NOT NULL, content text NOT NULL, choices jsonb, dice jsonb,
  model_used text, task_type text, prompt_tokens integer, completion_tokens integer,
  created_at timestamp NOT NULL
);
CREATE TABLE inventory_items (
  id uuid PRIMARY KEY, session_id uuid NOT NULL, name text NOT NULL, kind text NOT NULL,
  description text NOT NULL, quantity integer NOT NULL, equipped boolean NOT NULL,
  power integer NOT NULL, icon text NOT NULL
);
CREATE TABLE memory_nodes (
  id uuid PRIMARY KEY, session_id uuid NOT NULL, layer text NOT NULL, category text NOT NULL,
  title text NOT NULL, content text NOT NULL, importance real NOT NULL, salience real NOT NULL,
  tokens_estimate integer NOT NULL, parent_id uuid, turn_from integer, turn_to integer,
  access_count integer NOT NULL, last_accessed_at timestamp, created_at timestamp NOT NULL
);
CREATE TABLE memory_links (id uuid PRIMARY KEY, from_id uuid NOT NULL, to_id uuid NOT NULL, relation text NOT NULL);
CREATE TABLE memory_embeddings (
  id uuid PRIMARY KEY, memory_node_id uuid NOT NULL, session_id uuid NOT NULL, model text NOT NULL,
  dims integer NOT NULL, content_hash text NOT NULL, status text NOT NULL, attempts integer NOT NULL,
  error text, vector real[], created_at timestamp NOT NULL, updated_at timestamp NOT NULL
);
CREATE TABLE token_logs (
  id uuid PRIMARY KEY, session_id uuid, model text NOT NULL, task_type text NOT NULL,
  prompt_tokens integer NOT NULL, completion_tokens integer NOT NULL, total_tokens integer NOT NULL,
  latency_ms integer NOT NULL, success boolean NOT NULL, error text, key_index integer, created_at timestamp NOT NULL
);
CREATE TABLE workspace_preferences (
  id text PRIMARY KEY, display_name text NOT NULL, favorites jsonb NOT NULL, updated_at timestamp NOT NULL
);
`;

async function populateLegacy(pg: PGlite) {
  await pg.exec(legacySchema);
  await pg.exec(`
INSERT INTO ai_settings VALUES ('owner:legacy', '["synthetic-legacy-key"]', 'quality',
  'legacy-narration', 'legacy-action', 'legacy-compaction', 'legacy-fast', 'legacy-primary',
  '["legacy-primary","legacy-backup"]', true, 7, 83, '2026-09-01 12:30:00');
INSERT INTO game_sessions VALUES
  ('10000000-0000-4000-8000-000000000001', 'Тихая пекарня', 'custom', 'Наша история', 'Обычный день',
   '{"name":"Лада","hp":13,"notes":["помнить заказ"]}',
   '{"location":"Пекарня","time":"утро","flags":{"doorOpen":true}}',
   'active', 3, 432, '2026-09-01 12:00:00', '2026-09-02 13:00:00'),
  ('10000000-0000-4000-8000-000000000002', 'Библиотека', 'library', 'Книжный клуб', 'Найти книгу',
   '{"name":"Мирон","hp":9}', '{"location":"Архив","flags":{}}',
   'paused', 1, 95, '2026-09-03 10:00:00', '2026-09-03 11:00:00');
INSERT INTO game_turns VALUES
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 3,
   'player', 'Передаю письмо Марии.', '[]', 'null', NULL, NULL, 0, 0, '2026-09-02 12:59:00'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 3,
   'narrator', 'Мария приняла письмо у пекарни.', '["Поговорить","Испечь хлеб"]',
   '{"roll":17,"total":19}', 'legacy-narration', 'narration', 123, 41, '2026-09-02 13:00:00');
INSERT INTO inventory_items VALUES
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'Ключ от кладовой', 'key', 'Медный ключ', 2, true, 0, '🔑');
INSERT INTO memory_nodes VALUES
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'semantic', 'person', 'Мария', 'Мария работает в пекарне.', 81, 73, 17, NULL, 1, 2, 4,
   '2026-09-02 12:58:00', '2026-09-01 12:15:00'),
  ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   'episodic', 'event', 'Письмо', 'Лада передала письмо Марии.', 67, 61, 15,
   '40000000-0000-4000-8000-000000000001', 3, 3, 2, NULL, '2026-09-02 13:00:00');
INSERT INTO memory_links VALUES
  ('50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001',
   '40000000-0000-4000-8000-000000000002', 'received');
INSERT INTO memory_embeddings VALUES
  ('60000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002',
   '10000000-0000-4000-8000-000000000001', 'legacy-embedding', 2, 'literal-old-content-hash',
   'ready', 2, '', ARRAY[0.25,0.5]::real[], '2026-09-02 13:01:00', '2026-09-02 13:02:00');
INSERT INTO token_logs VALUES
  ('70000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'legacy-narration', 'narration', 123, 41, 164, 215, true, '', 1, '2026-09-02 13:00:00');
INSERT INTO workspace_preferences VALUES
  ('owner:legacy', 'Лада', '["10000000-0000-4000-8000-000000000001"]', '2026-09-01 12:30:00');
`);
}

function migrationClient(pg: PGlite) {
  return { query: async (text: string, values?: unknown[]) => values ? pg.query(text, values) : (await pg.exec(text)).at(-1)! };
}

// Capture all rows, including tables added by later migrations, so a replay that
// appends default rows or touches timestamps is observable beyond the ledger.
async function databaseRows(pg: PGlite) {
  const tables = await pg.query<{ schema: string; name: string }>(`
    SELECT schemaname AS schema, tablename AS name FROM pg_tables
    WHERE schemaname IN ('public', 'drizzle') ORDER BY schemaname, tablename`);
  const result: Record<string, unknown> = {};
  for (const { schema, name } of tables.rows) {
    const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`;
    result[`${schema}.${name}`] = (await pg.query(`
      SELECT to_jsonb(row_data) AS row FROM ${quoted(schema)}.${quoted(name)} row_data
      ORDER BY to_jsonb(row_data)::text`)).rows;
  }
  return result;
}

async function assertUpgraded(pg: PGlite) {
  assert.deepEqual((await pg.query(`SELECT id, title, scenario_id, scenario_title, scenario_prompt,
    character, world_state, status, turn_count, context_tokens_estimate,
    created_at::text, updated_at::text, campaign_mode, rules_profile, last_compact_turn,
    branch_origin, owner_id, visibility FROM game_sessions ORDER BY id`)).rows, [
    {
      id: '10000000-0000-4000-8000-000000000001', title: 'Тихая пекарня', scenario_id: 'custom',
      scenario_title: 'Наша история', scenario_prompt: 'Обычный день',
      character: { name: 'Лада', hp: 13, notes: ['помнить заказ'] },
      world_state: { location: 'Пекарня', time: 'утро', flags: { doorOpen: true } },
      status: 'active', turn_count: 3, context_tokens_estimate: 432,
      created_at: '2026-09-01 12:00:00', updated_at: '2026-09-02 13:00:00',
      campaign_mode: 'free', rules_profile: 'd20', last_compact_turn: 0,
      branch_origin: null, owner_id: null, visibility: 'private',
    },
    {
      id: '10000000-0000-4000-8000-000000000002', title: 'Библиотека', scenario_id: 'library',
      scenario_title: 'Книжный клуб', scenario_prompt: 'Найти книгу', character: { name: 'Мирон', hp: 9 },
      world_state: { location: 'Архив', flags: {} }, status: 'paused', turn_count: 1,
      context_tokens_estimate: 95, created_at: '2026-09-03 10:00:00', updated_at: '2026-09-03 11:00:00',
      campaign_mode: 'preset', rules_profile: 'd20', last_compact_turn: 0,
      branch_origin: null, owner_id: null, visibility: 'private',
    },
  ]);
  assert.deepEqual((await pg.query(`SELECT id, session_id, turn_number, role, content, choices, dice,
    model_used, task_type, prompt_tokens, completion_tokens, created_at::text,
    request_id, state_changes, context_meta FROM game_turns ORDER BY id`)).rows, [
    {
      id: '20000000-0000-4000-8000-000000000001', session_id: '10000000-0000-4000-8000-000000000001',
      turn_number: 3, role: 'player', content: 'Передаю письмо Марии.', choices: [], dice: null,
      model_used: null, task_type: null, prompt_tokens: 0, completion_tokens: 0,
      created_at: '2026-09-02 12:59:00', request_id: null, state_changes: null, context_meta: null,
    },
    {
      id: '20000000-0000-4000-8000-000000000002', session_id: '10000000-0000-4000-8000-000000000001',
      turn_number: 3, role: 'narrator', content: 'Мария приняла письмо у пекарни.',
      choices: ['Поговорить', 'Испечь хлеб'], dice: { roll: 17, total: 19 },
      model_used: 'legacy-narration', task_type: 'narration', prompt_tokens: 123, completion_tokens: 41,
      created_at: '2026-09-02 13:00:00', request_id: null, state_changes: null, context_meta: null,
    },
  ]);
  assert.deepEqual((await pg.query(`SELECT id FROM game_turns
    WHERE role = 'narrator' AND evidence_search @@ plainto_tsquery('russian', 'письмо пекарня')`)).rows,
  [{ id: '20000000-0000-4000-8000-000000000002' }]);
  assert.deepEqual((await pg.query(`SELECT id, session_id, name, kind, description, quantity, equipped, power, icon,
    created_at IS NOT NULL AS has_created_at FROM inventory_items`)).rows, [{
    id: '30000000-0000-4000-8000-000000000001', session_id: '10000000-0000-4000-8000-000000000001',
    name: 'Ключ от кладовой', kind: 'key', description: 'Медный ключ', quantity: 2,
    equipped: true, power: 0, icon: '🔑', has_created_at: true,
  }]);
  assert.deepEqual((await pg.query(`SELECT id, session_id, layer, category, title, content, importance,
    salience, tokens_estimate, parent_id, turn_from, turn_to, access_count,
    last_accessed_at::text, created_at::text, source, source_turn, content_hash, entity_key,
    confidence, evidence, updated_at IS NOT NULL AS has_updated_at FROM memory_nodes ORDER BY id`)).rows, [
    {
      id: '40000000-0000-4000-8000-000000000001', session_id: '10000000-0000-4000-8000-000000000001',
      layer: 'semantic', category: 'person', title: 'Мария', content: 'Мария работает в пекарне.',
      importance: 81, salience: 73, tokens_estimate: 17, parent_id: null, turn_from: 1, turn_to: 2,
      access_count: 4, last_accessed_at: '2026-09-02 12:58:00', created_at: '2026-09-01 12:15:00',
      source: 'heuristic', source_turn: null, content_hash: null, entity_key: null,
      confidence: 1, evidence: null, has_updated_at: true,
    },
    {
      id: '40000000-0000-4000-8000-000000000002', session_id: '10000000-0000-4000-8000-000000000001',
      layer: 'episodic', category: 'event', title: 'Письмо', content: 'Лада передала письмо Марии.',
      importance: 67, salience: 61, tokens_estimate: 15, parent_id: '40000000-0000-4000-8000-000000000001',
      turn_from: 3, turn_to: 3, access_count: 2, last_accessed_at: null, created_at: '2026-09-02 13:00:00',
      source: 'heuristic', source_turn: null, content_hash: null, entity_key: null,
      confidence: 1, evidence: null, has_updated_at: true,
    },
  ]);
  assert.deepEqual((await pg.query('SELECT * FROM memory_links')).rows, [{
    id: '50000000-0000-4000-8000-000000000001', from_id: '40000000-0000-4000-8000-000000000001',
    to_id: '40000000-0000-4000-8000-000000000002', relation: 'received',
  }]);
  assert.deepEqual((await pg.query(`SELECT id, memory_node_id, session_id, model, dims, content_hash,
    status, attempts, error, vector, created_at::text, updated_at::text, lease_token,
    lease_expires_at, next_attempt_at IS NOT NULL AS has_next_attempt_at FROM memory_embeddings`)).rows, [{
    id: '60000000-0000-4000-8000-000000000001', memory_node_id: '40000000-0000-4000-8000-000000000002',
    session_id: '10000000-0000-4000-8000-000000000001', model: 'legacy-embedding', dims: 2,
    content_hash: 'literal-old-content-hash', status: 'ready', attempts: 2, error: '', vector: [0.25, 0.5],
    created_at: '2026-09-02 13:01:00', updated_at: '2026-09-02 13:02:00',
    lease_token: null, lease_expires_at: null, has_next_attempt_at: true,
  }]);
  assert.deepEqual((await pg.query('SELECT to_jsonb(ai_settings) AS settings FROM ai_settings')).rows, [{ settings: {
    id: 'owner:legacy', keys: ['synthetic-legacy-key'], routing_profile: 'quality',
    narration_model: 'legacy-narration', custom_action_model: 'legacy-action', compaction_model: 'legacy-compaction',
    fast_task_model: 'legacy-fast', primary_model: 'legacy-primary', fallback_chain: ['legacy-primary', 'legacy-backup'],
    use_live_ai: true, daily_flash_limit: 7, daily_lite_limit: 83, updated_at: '2026-09-01T12:30:00',
    enforce_limits: true, embeddings_enabled: true, embedding_model: 'gemini-embedding-2', embedding_dims: 768,
    semantic_extraction_enabled: true, typesafe_key: '', typesafe_pilot_enabled: false,
    narrative_guard_enabled: true, narrative_guard_provider: 'openrouter', narrative_guard_key: '',
    keys_shared_project: true, daily_embedding_limit: 5000, text_provider: 'gemini', text_model: '',
    openrouter_key: '', pollinations_key: '', pollinations_key_expires_at: null,
  } }]);
  assert.deepEqual((await pg.query('SELECT to_jsonb(workspace_preferences) AS preferences FROM workspace_preferences')).rows,
    [{ preferences: { id: 'owner:legacy', display_name: 'Лада', favorites: ['10000000-0000-4000-8000-000000000001'],
      updated_at: '2026-09-01T12:30:00', reading: { textScale: 'normal', measure: 'normal', theme: 'midnight', motion: 'full' } } }]);
  assert.deepEqual((await pg.query('SELECT to_jsonb(token_logs) AS log FROM token_logs')).rows, [{ log: {
    id: '70000000-0000-4000-8000-000000000001', session_id: '10000000-0000-4000-8000-000000000001',
    model: 'legacy-narration', task_type: 'narration', prompt_tokens: 123, completion_tokens: 41,
    total_tokens: 164, latency_ms: 215, success: true, error: '', key_index: 1,
    created_at: '2026-09-02T13:00:00', owner_id: null, quota_reserved: false,
  } }]);
  // Real FK enforcement matters for old rows too: no remapped or orphan IDs.
  await assert.rejects(pg.query(`UPDATE memory_embeddings SET memory_node_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'`),
    /memory_embeddings_memory_node_id_memory_nodes_id_fk/);
  await assert.rejects(pg.query(`UPDATE game_turns SET session_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'`),
    /game_turns_session_id_game_sessions_id_fk/);
}

async function assertExactLedger(pg: PGlite) {
  const journal = JSON.parse(await readFile('./drizzle/meta/_journal.json', 'utf8')) as {
    entries: Array<{ tag: string; when: number }>;
  };
  const expected = await Promise.all(journal.entries.map(async (entry, index) => ({
    id: index + 1, created_at: String(entry.when),
    hash: createHash('sha256').update(await readFile(`./drizzle/${entry.tag}.sql`)).digest('hex'),
  })));
  assert.deepEqual((await pg.query('SELECT id, hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY id')).rows, expected);
}

// Breaks if an additive migration drops/rewrites old data, misses a legacy
// default/backfill, loses a foreign key, skips a journal entry, or replays writes.
test('full production journal upgrades populated pre-0000 data and replay leaves every row unchanged', async () => {
  const pg = new PGlite({ extensions: { vector, pgcrypto } });
  try {
    await populateLegacy(pg);
    const migrations = readMigrationFiles({ migrationsFolder: './drizzle' });
    assert.equal(await applyMigrations(migrationClient(pg), migrations), migrations.length);
    await assertUpgraded(pg);
    await assertExactLedger(pg);
    const committed = await databaseRows(pg);
    assert.equal(await applyMigrations(migrationClient(pg), migrations), 0);
    assert.deepEqual(await databaseRows(pg), committed);
    await assertExactLedger(pg);
  } finally { await pg.close(); }
});

// Breaks if the production runner commits migrations one at a time, swallows a
// failing statement, or leaves data/ledger work behind which blocks a full retry.
test('late failure rolls the populated legacy upgrade back and the full journal can be retried', async () => {
  const pg = new PGlite({ extensions: { vector, pgcrypto } });
  try {
    await populateLegacy(pg);
    const original = await databaseRows(pg);
    const migrations = readMigrationFiles({ migrationsFolder: './drizzle' });
    const failedFuture = {
      folderMillis: migrations.at(-1)!.folderMillis + 1, hash: 'synthetic-populated-upgrade-failure', bps: true,
      sql: [
        `UPDATE game_sessions SET title = 'Не должно сохраниться'`,
        `DELETE FROM memory_links`,
        `CREATE TABLE populated_upgrade_probe (id integer PRIMARY KEY)`,
        `SELECT missing_populated_upgrade_column FROM populated_upgrade_probe`,
      ],
    };
    await assert.rejects(applyMigrations(migrationClient(pg), [...migrations, failedFuture]), /missing_populated_upgrade_column/);
    assert.deepEqual(await databaseRows(pg), original);
    assert.deepEqual((await pg.query(`SELECT to_regclass('drizzle.__drizzle_migrations') AS ledger,
      to_regclass('populated_upgrade_probe') AS probe,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'game_sessions' AND column_name = 'owner_id') AS has_owner`)).rows,
    [{ ledger: null, probe: null, has_owner: false }]);
    assert.equal(await applyMigrations(migrationClient(pg), migrations), migrations.length);
    await assertUpgraded(pg);
    await assertExactLedger(pg);
    const retried = await databaseRows(pg);
    assert.equal(await applyMigrations(migrationClient(pg), migrations), 0);
    assert.deepEqual(await databaseRows(pg), retried);
  } finally { await pg.close(); }
});
