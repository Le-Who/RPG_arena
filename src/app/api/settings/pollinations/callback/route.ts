import { cookies } from "next/headers";
import { currentProfileId } from "@/lib/identity";
import { withIdentityWork } from "@/lib/owner-work";
import { finishPollinationsConnect, pollinationsOAuthConfig, POLLINATIONS_OAUTH_COOKIE } from "@/lib/pollinations-oauth";
import { attachPollinationsKey } from "@/lib/text-provider-settings";
export const dynamic = "force-dynamic";
function settingsResult(destination: URL, outcome: "connected" | "cancelled" | "failed") {
  destination.searchParams.set("pollinations", outcome);
  return new Response(null, { status: 303, headers: { Location: destination.href, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
export const GET = withIdentityWork(async (request: Request) => {
  const jar = await cookies(), cookie = jar.get(POLLINATIONS_OAUTH_COOKIE)?.value ?? "";
  jar.delete({ name: POLLINATIONS_OAUTH_COOKIE, path: "/api/settings/pollinations" });
  let destination: URL | undefined;
  try {
    const cfg = pollinationsOAuthConfig();
    if (!cfg) throw new Error("not_configured");
    destination = new URL("/settings", cfg.redirectUri);
    const query = new URL(request.url).searchParams;
    if (query.get("error") === "access_denied") return settingsResult(destination, "cancelled");
    if (query.has("error")) throw new Error("declined");
    const owner = await currentProfileId();
    const result = await finishPollinationsConnect(owner, cfg, cookie, query.get("state") ?? "", query.get("code") ?? "");
    // Token exchange can outlive the session that admitted this callback.
    if (await currentProfileId() !== owner) throw new Error("identity_changed");
    await attachPollinationsKey(owner, result.key, result.expiresAt);
  } catch {
    // No provider errors, authorization code or token in logs or redirect URL.
    if (destination) return settingsResult(destination, "failed");
    return new Response("Не удалось подключить Pollinations. Вернитесь в настройки и повторите подключение.", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }
  return settingsResult(destination, "connected");
});
