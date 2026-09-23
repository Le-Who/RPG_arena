import { withCampaignAccess } from "@/lib/campaign-access";
import { exportCampaignMarkdown, exportPortableCampaign } from "@/lib/campaign-export";
import { currentProfileId } from "@/lib/identity";
export const dynamic = "force-dynamic";
async function handleGET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (new URL(request.url).searchParams.get("format") === "json") {
    const document = await exportPortableCampaign(id, await currentProfileId());
    if (!document) return Response.json({ ok: false, code: "NOT_FOUND", message: "Кампания не найдена." }, { status: 404 });
    return Response.json(document, { headers: { "Content-Disposition": `attachment; filename="chronicle-${id.slice(0, 8)}.json"` } });
  }
  const text = await exportCampaignMarkdown(id);
  if (text === null) return Response.json({ error: "История не найдена" }, { status: 404 });
  return new Response(text, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="chronicle-${id.slice(0, 8)}.md"` } });
}

export const GET = withCampaignAccess("read", handleGET);
