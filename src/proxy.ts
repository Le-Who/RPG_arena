import { NextRequest, NextResponse } from "next/server";
export function proxy(req: NextRequest) {
  const id = req.nextUrl.pathname.match(/^\/api\/sessions\/([^/]+)/)?.[1];
  if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return NextResponse.json({ error: "Некорректный идентификатор кампании" }, { status: 400 });
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    if (req.headers.get("sec-fetch-site") === "cross-site") return NextResponse.json({ error: "Cross-site request rejected" }, { status: 403 });
    const length = Number(req.headers.get("content-length") || 0);
    if (length > 65536) return NextResponse.json({ error: "Слишком большой запрос" }, { status: 413 });
  }
  return NextResponse.next();
}
export const config = { matcher: "/api/:path*" };
