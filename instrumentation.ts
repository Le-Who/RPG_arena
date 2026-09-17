/**
 * Next.js Instrumentation Hook — выполняется один раз при старте сервера (Node.js runtime).
 * Применяет versioned-миграции из drizzle/ через ledger __drizzle_migrations (см. src/db/migrate.ts).
 * Поведение при ошибке: сервер поднимается (fail-open, чтобы /api/health мог сообщить о проблеме),
 * но ошибка выводится в лог. Установите MIGRATIONS_STRICT=1, чтобы падать при ошибке миграции.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { runMigrations } = await import("./src/db/migrate");
  const result = await runMigrations();
  if (!result.ok && process.env.MIGRATIONS_STRICT === "1") {
    throw new Error(`Migrations failed: ${result.error}`);
  }
}
