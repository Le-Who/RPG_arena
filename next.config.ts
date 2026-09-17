import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // instrumentation.ts поддерживается нативно в Next.js 15+ без флагов.
  // При каждом старте сервера (dev/prod) выполняется src/db/migrate.ts
  // для идемпотентного применения SQL-миграций из drizzle/.
};

export default nextConfig;
