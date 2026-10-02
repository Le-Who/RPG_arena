import { APP_BUILD_ID } from "@/lib/build-version";
import { serviceWorkerSource } from "@/lib/service-worker-source";

export const dynamic = "force-dynamic";

export function GET() {
  return new Response(serviceWorkerSource(APP_BUILD_ID), { headers: {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "X-Content-Type-Options": "nosniff",
    "Service-Worker-Allowed": "/",
  } });
}
