/**
 * DATA-1a: versioned-миграции через drizzle migrator.
 * · Ledger: таблица __drizzle_migrations — каждый файл применяется ровно один раз.
 * · SQL-файлы в drizzle/ написаны идемпотентно (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / guarded FK),
 *   поэтому безопасны и для чистой БД, и для апгрейда с v1, и при параллельном `drizzle-kit push`.
 * · Ошибка миграции логируется и пробрасывается вызывающему (instrumentation решает, ронять ли процесс).
 */
import path from "path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

export async function runMigrations(): Promise<{ ok: boolean; error?: string }> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.warn("[migrate] DATABASE_URL not set — skipping migrations");
    return { ok: false, error: "DATABASE_URL not set" };
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    const db = drizzle(pool);
    const migrationsFolder = path.join(process.cwd(), "drizzle");
    await migrate(db, { migrationsFolder });
    console.log("[migrate] ✓ schema is up to date");
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[migrate] ✗", msg);
    return { ok: false, error: msg };
  } finally {
    await pool.end().catch(() => {});
  }
}
