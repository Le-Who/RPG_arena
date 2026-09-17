-- ============================================================
-- Patch: performance indexes for high-frequency queries
-- Apply: psql $DATABASE_URL -f drizzle/patch_indexes.sql
-- ============================================================

-- game_turns: base index on session_id (all WHERE session_id = ? queries)
CREATE INDEX IF NOT EXISTS idx_game_turns_session_id
  ON game_turns (session_id);

-- game_turns: composite for playerCountResult
-- (WHERE session_id=? AND role='player' AND turn_number > ?)
CREATE INDEX IF NOT EXISTS idx_game_turns_session_role_turn
  ON game_turns (session_id, role, turn_number);

-- game_turns: ORDER BY turn_number DESC + LIMIT (recentTurns fetch)
CREATE INDEX IF NOT EXISTS idx_game_turns_session_turn_desc
  ON game_turns (session_id, turn_number DESC);

-- memory_nodes: WHERE session_id + ORDER BY weighted rank
CREATE INDEX IF NOT EXISTS idx_memory_nodes_session_importance
  ON memory_nodes (session_id, importance DESC);

-- memory_nodes: recency query (session_id, turn_to DESC)
CREATE INDEX IF NOT EXISTS idx_memory_nodes_session_turnto
  ON memory_nodes (session_id, turn_to DESC);

-- inventory_items: WHERE session_id = ?
CREATE INDEX IF NOT EXISTS idx_inventory_items_session_id
  ON inventory_items (session_id);

-- world_locations: WHERE session_id = ?
CREATE INDEX IF NOT EXISTS idx_world_locations_session_id
  ON world_locations (session_id);

-- token_logs: WHERE session_id (analytics; nullable FK — index still useful)
CREATE INDEX IF NOT EXISTS idx_token_logs_session_id
  ON token_logs (session_id);

-- token_logs: ORDER BY created_at DESC (monitoring dashboard)
CREATE INDEX IF NOT EXISTS idx_token_logs_created_at
  ON token_logs (created_at DESC);
