import { getSystemStatus } from "@/lib/system-status";
import { httpError } from "@/lib/http";
export const dynamic = "force-dynamic";
export async function GET() {
  try { return Response.json(await getSystemStatus(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return httpError(error); }
}
