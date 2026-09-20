import { withCampaignAccess } from "@/lib/campaign-access";
import { exportCampaignMarkdown } from "@/lib/campaign-export";
export const dynamic = "force-dynamic";
async function handleGET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const text = await exportCampaignMarkdown(id);
  if (text === null) return Response.json({ error: "История не найдена" }, { status: 404 });
  return new Response(text, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="chronicle-${id.slice(0, 8)}.md"` } });
}

export const GET = withCampaignAccess("read", handleGET);
