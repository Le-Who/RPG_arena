import { pollinationsOAuthConfig } from "@/lib/pollinations-oauth";
export const dynamic = "force-dynamic";
/** Public OAuth client metadata. No identity, database or credentials are exposed. */
export async function GET() {
  try {
    const cfg = pollinationsOAuthConfig();
    if (!cfg?.clientId.startsWith("https://")) return new Response(null, { status: 404 });
    return Response.json({ client_id: cfg.clientId, client_name: "Chronicle Engine", redirect_uris: [cfg.redirectUri], token_endpoint_auth_method: "none" }, { headers: { "Cache-Control": "no-store" } });
  } catch { return new Response(null, { status: 404 }); }
}
