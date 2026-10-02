import { checkReadiness, readinessResponse } from "@/lib/readiness";

export const dynamic = "force-dynamic";

export async function GET() {
  const state = await checkReadiness(async (text, values) => {
    const { pool } = await import("@/db");
    return pool.query(text, values);
  });
  return readinessResponse(state);
}
