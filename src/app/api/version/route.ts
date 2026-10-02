import { APP_BUILD_ID } from "@/lib/build-version";

export const dynamic = "force-dynamic";

/** Public deployment metadata: deliberately independent of identity and database readiness. */
export function GET() {
  return Response.json({ buildId: APP_BUILD_ID }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
