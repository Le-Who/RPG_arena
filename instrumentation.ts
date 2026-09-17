/**
 * Next.js Instrumentation Hook
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * Выполняется ОДИН РАЗ при старте сервера (до первого запроса).
 * Применяет все SQL-миграции из drizzle/ идемпотентно:
 * каждый файл использует CREATE TABLE/INDEX IF NOT EXISTS → безопасно запускать повторно.
 *
 * Порядок применения: сначала базовая схема (0000_), затем патчи по алфавиту.
 */

export async function register() {
  // Instrumentation запускается и на стороне edge runtime — там pg недоступен.
  // Ограничиваем выполнение только Node.js runtime.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { runMigrations } = await import("./src/db/migrate");
  await runMigrations();
}
