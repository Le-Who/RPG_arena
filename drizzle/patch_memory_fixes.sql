-- ============================================================
-- Патч: добавление поля lastCompactTurn и FK для parentId/memoryLinks
-- Применяй к существующей БД вместо 0000_foamy_slapstick.sql
-- ============================================================

-- 1. Добавляем lastCompactTurn в game_sessions
--    (Fix #1, #4: надёжное хранение последнего скомпакченного хода)
ALTER TABLE game_sessions
  ADD COLUMN IF NOT EXISTS last_compact_turn INTEGER NOT NULL DEFAULT 0;

-- 2. Добавляем self-referencing FK на parent_id в memory_nodes
--    (Fix #13: parentId раньше был без внешнего ключа — данные могли осиротеть)
--    onDelete SET NULL: удаление родителя не удаляет детей, только обнуляет ссылку.
ALTER TABLE memory_nodes
  ADD CONSTRAINT IF NOT EXISTS memory_nodes_parent_id_fkey
    FOREIGN KEY (parent_id) REFERENCES memory_nodes(id) ON DELETE SET NULL;

-- 3. Добавляем FK на from_id и to_id в memory_links
--    (Fix #13: таблица была без FK — возможны висячие ссылки при удалении нод)
--    onDelete CASCADE: удаление ноды удаляет все её связи.
ALTER TABLE memory_links
  ADD CONSTRAINT IF NOT EXISTS memory_links_from_id_fkey
    FOREIGN KEY (from_id) REFERENCES memory_nodes(id) ON DELETE CASCADE;

ALTER TABLE memory_links
  ADD CONSTRAINT IF NOT EXISTS memory_links_to_id_fkey
    FOREIGN KEY (to_id) REFERENCES memory_nodes(id) ON DELETE CASCADE;
