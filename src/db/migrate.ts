/**
 * Модуль автоматического применения SQL-миграций при старте сервера.
 *
 * Логика:
 * 1. Читает все .sql файлы из drizzle/ в алфавитном порядке.
 * 2. Выполняет каждый в одной транзакции через pg напрямую (без drizzle-kit).
 * 3. Все файлы содержат IF NOT EXISTS → идемпотентно, безопасно перезапускать.
 * 4. Ошибки логируются, но НЕ прерывают старт сервера (fail-open):
 *    если БД временно недоступна при деплое — сервер всё равно поднимается.
 *
 * Порядок: 0000_foamy_slapstick.sql → patch_indexes.sql → patch_memory_fixes.sql
 * (лексикографический, что совпадает с хронологией создания файлов).
 */

import fs from "fs";
import path from "path";
import { Pool } from "pg";

export async function runMigrations() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.warn("[migrate] DATABASE_URL not set — skipping migrations");
    return;
  }

  // Используем отдельный пул с коротким таймаутом — не мешаем основному app-пулу.
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 10000,
  });

  try {
    const migrationsDir = path.join(process.cwd(), "drizzle");

    // Читаем все .sql файлы, сортируем лексикографически
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    if (files.length === 0) {
      console.log("[migrate] No .sql files found in drizzle/");
      return;
    }

    console.log(`[migrate] Applying ${files.length} migration file(s)...`);

    for (const file of files) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, "utf-8");

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("COMMIT");
        console.log(`[migrate] ✓ ${file}`);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        // Логируем ошибку конкретного файла, но продолжаем остальные.
        // Типичный сценарий: индекс уже существует под другим именем — не фатально.
        console.error(`[migrate] ✗ ${file}:`, err instanceof Error ? err.message : err);
      } finally {
        client.release();
      }
    }

    console.log("[migrate] Done.");
  } catch (err) {
    // Fail-open: не роняем сервер если migrationsDir не найден или pg недоступен.
    console.error("[migrate] Migration runner error:", err instanceof Error ? err.message : err);
  } finally {
    await pool.end().catch(() => {});
  }
}
