import { NextRequest, NextResponse } from "next/server";
import { GUEST_COOKIE, GUEST_MAX_AGE, newGuestToken, profileIdFromToken } from "./lib/guest-identity";
import { auth } from "./lib/auth";
import { assertAuthOrigin } from "./lib/auth-policy";
import { httpError } from "./lib/http";
export async function proxy(req: NextRequest) {
  // Readiness must not depend on guest identity or an already migrated auth schema.
  if (req.nextUrl.pathname === "/api/health") return NextResponse.next();
  const id = req.nextUrl.pathname.match(/^\/api\/sessions\/([^/]+)/)?.[1];
  if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return NextResponse.json({ error: "Некорректный идентификатор кампании" }, { status: 400 });
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    if (req.nextUrl.pathname.startsWith("/api/")) {
      try { assertAuthOrigin(req); } catch (error) {
        const denied = httpError(error);
        return new NextResponse(denied.body, { status: denied.status, headers: denied.headers });
      }
    }
    if (req.headers.get("sec-fetch-site") === "cross-site") return NextResponse.json({ error: "Cross-site request rejected" }, { status: 403 });
    const length = Number(req.headers.get("content-length") || 0);
    if (length > 65536) return NextResponse.json({ error: "Слишком большой запрос" }, { status: 413 });
  }
  const existing = req.cookies.get(GUEST_COOKIE)?.value;
  const token = profileIdFromToken(existing) && await auth.guestProfile(existing) ? existing! : newGuestToken();
  req.cookies.set(GUEST_COOKIE, token);
  const response = NextResponse.next({ request: { headers: req.headers } });
  if (token !== existing) response.cookies.set(GUEST_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: req.nextUrl.protocol === "https:", path: "/", maxAge: GUEST_MAX_AGE });
  if (req.nextUrl.pathname.startsWith("/api/")) response.headers.set("Cache-Control", "private, no-store");
  return response;
}
export const config = { matcher: ["/((?!_next/|favicon.ico|.*\\.(?:png|jpg|jpeg|webp|svg|ico|woff2?)$).*)"] };
