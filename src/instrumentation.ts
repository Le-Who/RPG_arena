export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.CHRONICLE_AUTO_MIGRATE === "1") {
    const { initializeServerMigrations } = await import("./lib/auto-migrate");
    await initializeServerMigrations();
  }
}
