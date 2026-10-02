import { withAdminAccess } from "@/lib/admin-access";
import { httpError } from "@/lib/http";
import { loadPerformanceReport } from "@/lib/performance-store";

export const dynamic = "force-dynamic";

async function handleGET(req: Request) {
  try {
    const days = Number(new URL(req.url).searchParams.get("days") ?? 7);
    return Response.json(await loadPerformanceReport(days), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return httpError(error); }
}
export const GET = withAdminAccess(handleGET);
