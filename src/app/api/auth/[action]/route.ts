import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { assertAuthOrigin, authRateLimitClient, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/auth-policy";
import { GUEST_COOKIE, GUEST_MAX_AGE, newGuestToken } from "@/lib/guest-identity";
import { HttpError, httpError, readJsonObject } from "@/lib/http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ action: string }> };
function tokens(request: Request) {
  const cookies = new NextRequest(request.url, { headers: request.headers }).cookies;
  return { guest: cookies.get(GUEST_COOKIE)?.value ?? "", session: cookies.get(SESSION_COOKIE)?.value ?? "" };
}
export async function GET(request: Request, context: Context) {
  try {
    if ((await context.params).action !== "me") throw new HttpError(404, "NOT_FOUND", "Не найдено.");
    const { guest, session } = tokens(request);
    return NextResponse.json({ ok: true, identity: await auth.view(guest, session) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return httpError(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    assertAuthOrigin(request);
    const { action } = await context.params;
    if (!["register", "login", "logout", "logout-all", "password", "adopt-guest"].includes(action)) throw new HttpError(404, "NOT_FOUND", "Не найдено.");
    // Logout never needs an expensive password check and remains available under throttling.
    if (action !== "logout") await auth.rateLimit(action, authRateLimitClient(request));
    const body = await readJsonObject(request, 4096);
    let { guest, session } = tokens(request);
    const originalSession = session;
    if (action === "register") {
      const current = await auth.resolve(guest, session);
      if (current.kind === "account") throw new HttpError(409, "ALREADY_AUTHENTICATED", "Сначала выйдите из аккаунта.");
      const result = await auth.register(guest, body.login, body.password as string);
      guest = result.guestToken; session = result.sessionToken;
    } else if (action === "login") {
      const result = await auth.login(guest, body.login, body.password);
      guest = result.guestToken; session = result.sessionToken;
      await auth.logout(originalSession);
    } else if (action === "adopt-guest") {
      const result = await auth.adopt(guest, session);
      guest = result.guestToken;
    } else {
      if (action === "password") await auth.changePassword(session, body.oldPassword, body.newPassword as string);
      else if (action === "logout-all") await auth.logoutAll(session);
      else await auth.logout(session);
      session = "";
      if (!await auth.guestProfile(guest)) guest = newGuestToken();
    }
    const response = NextResponse.json({ ok: true, identity: await auth.view(guest, session) }, { headers: { "Cache-Control": "private, no-store" } });
    const flags = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production" || new URL(request.url).protocol === "https:", path: "/" };
    response.cookies.set(GUEST_COOKIE, guest, { ...flags, maxAge: GUEST_MAX_AGE });
    if (action !== "adopt-guest") response.cookies.set(SESSION_COOKIE, session, { ...flags, maxAge: session ? SESSION_MAX_AGE : 0 });
    return response;
  } catch (error) { return httpError(error); }
}
