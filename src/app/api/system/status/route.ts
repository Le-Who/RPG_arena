import { getSystemStatus } from "@/lib/system-status";
import { httpError } from "@/lib/http";
import { requireAdmin } from "@/lib/admin-access";
export const dynamic = "force-dynamic";
export async function GET() {
  try { await requireAdmin(); return Response.json(await getSystemStatus(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return httpError(error); }
}
