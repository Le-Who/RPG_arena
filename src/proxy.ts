import { NextRequest, NextResponse } from "next/server";
import { GUEST_COOKIE, GUEST_MAX_AGE, newGuestToken, profileIdFromToken } from "./lib/guest-identity";
import { auth } from "./lib/auth";
import { assertAuthOrigin } from "./lib/auth-policy";
import { httpError } from "./lib/http";
import { CHECKPOINT_MAX_BYTES } from "./lib/checkpoint-types";
async function handleProxy(req: NextRequest) {
  if (["/sw.js", "/offline.html", "/manifest.webmanifest"].includes(req.nextUrl.pathname)) return NextResponse.next();
  // Readiness must not depend on guest identity or an already migrated auth schema.
  if (["/api/health", "/api/version", "/api/settings/pollinations/client"].includes(req.nextUrl.pathname)) return NextResponse.next();
  const id = req.nextUrl.pathname.match(/^\/api\/sessions\/([^/]+)/)?.[1];
  const importPath = req.nextUrl.pathname === "/api/sessions/import";
  if (id && !importPath && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return NextResponse.json({ error: "Некорректный идентификатор кампании" }, { status: 400 });
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    if (req.nextUrl.pathname.startsWith("/api/")) {
      try { assertAuthOrigin(req); } catch (error) {
        const denied = httpError(error);
        return new NextResponse(denied.body, { status: denied.status, headers: denied.headers });
      }
    }
    if (req.headers.get("sec-fetch-site") === "cross-site") return NextResponse.json({ error: "Cross-site request rejected" }, { status: 403 });
    const length = Number(req.headers.get("content-length") || 0);
    if (length > (importPath && req.method === "POST" ? CHECKPOINT_MAX_BYTES + 4096 : 65536)) return NextResponse.json({ error: "Слишком большой запрос" }, { status: 413 });
  }
  // Anonymous, bounded telemetry uses no guest identity; same-origin checks above still apply.
  if (req.nextUrl.pathname === "/api/telemetry/vitals") {
    const response = NextResponse.next(); response.headers.set("Cache-Control", "no-store"); return response;
  }
  const existing = req.cookies.get(GUEST_COOKIE)?.value;
  // Repair at identity boundaries, not independently in parallel data requests:
  // otherwise an old consumed token can receive several competing replacements.
  // Ordinary APIs still resolve fresh identity and reject consumed guests in handlers.
  const needsDatabaseIdentity = req.nextUrl.pathname === "/api/bootstrap" || req.nextUrl.pathname.startsWith("/api/auth/") || req.nextUrl.pathname.startsWith("/system");
  const token = profileIdFromToken(existing) && (!needsDatabaseIdentity || await auth.guestProfile(existing)) ? existing! : newGuestToken();
  req.cookies.set(GUEST_COOKIE, token);
  const response = NextResponse.next({ request: { headers: req.headers } });
  if (token !== existing) response.cookies.set(GUEST_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" || req.nextUrl.protocol === "https:", path: "/", maxAge: GUEST_MAX_AGE });
  if (req.nextUrl.pathname.startsWith("/api/")) response.headers.set("Cache-Control", "private, no-store");
  return response;
}
export async function proxy(req: NextRequest) {
  const started = performance.now();
  const response = await handleProxy(req);
  if (req.nextUrl.pathname.startsWith("/api/") && !["/api/version", "/api/health", "/api/telemetry/vitals"].includes(req.nextUrl.pathname)) {
    response.headers.set("X-Chronicle-Proxy-Ms", Math.max(0, performance.now() - started).toFixed(1));
    response.headers.set("X-Chronicle-Proxy-Region", /^[a-z]{3}\d$/.test(process.env.VERCEL_REGION ?? "") ? process.env.VERCEL_REGION! : "local");
  }
  return response;
}
export const config = { matcher: ["/((?!_next/|favicon.ico|.*\\.(?:png|jpg|jpeg|webp|svg|ico|woff2?)$).*)"] };
