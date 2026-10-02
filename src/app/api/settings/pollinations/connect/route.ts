import { cookies } from "next/headers";
import { currentProfileId } from "@/lib/identity";
import { withIdentityWork } from "@/lib/owner-work";
import { HttpError, httpError } from "@/lib/http";
import { beginPollinationsConnect, pollinationsOAuthConfig, POLLINATIONS_OAUTH_COOKIE } from "@/lib/pollinations-oauth";
export const dynamic = "force-dynamic";
export const GET = withIdentityWork(async () => {
  try { return Response.json({ available: !!pollinationsOAuthConfig() }); }
  catch { return Response.json({ available: false }); }
});
export const POST = withIdentityWork(async () => {
  try {
    const cfg = pollinationsOAuthConfig();
    if (!cfg) throw new HttpError(503, "POLLINATIONS_APP_UNCONFIGURED", "Для подключения кошелька администратору нужно настроить App Key и callback URL. Можно сохранить личный API-ключ вручную.");
    const result = await beginPollinationsConnect(await currentProfileId(), cfg);
    (await cookies()).set(POLLINATIONS_OAUTH_COOKIE, result.cookie, { httpOnly: true, secure: new URL(cfg.redirectUri).protocol === "https:", sameSite: "lax", path: "/api/settings/pollinations", maxAge: 600 });
    return Response.json({ url: result.url });
  } catch (error) { return httpError(error); }
});
