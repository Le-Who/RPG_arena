import type { NextConfig } from "next";
import { PHASE_PRODUCTION_SERVER } from "next/constants";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Next evaluates this module again in build workers. Export the automatic seed
// before config normalization so Next also retains it in its initial environment.
const buildSeed = process.env.CHRONICLE_BUILD_ID ?? randomUUID();
process.env.CHRONICLE_BUILD_ID = buildSeed;

const nextConfig = (phase: string): NextConfig => {
  // Startup overrides cannot change the identity of an already-built artifact.
  // This config is server-only; artifact paths never enter the browser module.
  const buildId = phase === PHASE_PRODUCTION_SERVER
    ? readFileSync(join(__dirname, ".next", "BUILD_ID"), "utf8").trim()
    : buildSeed;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(buildId)) {
    throw new Error(phase === PHASE_PRODUCTION_SERVER
      ? "The persisted build identity is invalid"
      : "CHRONICLE_BUILD_ID must contain 1–128 letters, digits, underscores or hyphens");
  }
  return {
    generateBuildId: async () => buildId,
    env: { NEXT_PUBLIC_CHRONICLE_BUILD_ID: buildId },
    async headers() {
      return [
        {
          source: "/:path*",
          headers: [
            { key: "X-Content-Type-Options", value: "nosniff" },
            { key: "X-Frame-Options", value: "DENY" },
            { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          ],
        },
        {
          source: "/sw.js",
          headers: [
            { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
            { key: "Content-Type", value: "application/javascript; charset=utf-8" },
            { key: "X-Content-Type-Options", value: "nosniff" },
          ],
        },
        {
          // Config headers take precedence over Route Handler response headers.
          source: "/api/settings/pollinations/callback",
          headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
        },
      ];
    },
  };
};

export default nextConfig;
