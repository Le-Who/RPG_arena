import type { NextConfig } from "next";
import { randomUUID } from "node:crypto";

// One value is captured by both generateBuildId and the client/server compiler.
// Never derive the running application's identity from next.config at server startup.
const buildId = process.env.CHRONICLE_BUILD_ID ?? randomUUID();
if (!/^[A-Za-z0-9_-]{1,128}$/.test(buildId)) {
  throw new Error("CHRONICLE_BUILD_ID must contain 1–128 letters, digits, underscores or hyphens");
}

const nextConfig: NextConfig = {
  generateBuildId: async () => buildId,
  env: { NEXT_PUBLIC_CHRONICLE_BUILD_ID: buildId },
  async headers() {
    return [
      {
        source: "/(.*)",
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
          { key: "X-Content-Type-Options", value: "nosniff" }
        ]
      }
    ];
  },
};

export default nextConfig;
