import { getSystemStatus } from "@/lib/system-status";
import { httpError } from "@/lib/http";
import { withAdminAccess } from "@/lib/admin-access";
export const dynamic = "force-dynamic";
async function handleGET() {
  try { return Response.json(await getSystemStatus(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return httpError(error); }
}
export const GET = withAdminAccess(handleGET);
