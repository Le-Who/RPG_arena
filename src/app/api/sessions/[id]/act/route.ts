import { NextResponse } from "next/server";
import { performTurn } from "@/lib/turn";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/sessions/:id/act
 * body: { action: string, custom: boolean, requestId?: string }
 * custom=true — свободное действие (серверная проверка по профилю до вызова AI).
 * requestId — idempotency-ключ: повтор с тем же ключом вернёт уже применённый результат.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { action?: unknown; custom?: unknown; requestId?: unknown };
  try {
    const result = await performTurn({
      sessionId: id,
      action: String(body.action ?? ""),
      isFree: Boolean(body.custom),
      requestId: typeof body.requestId === "string" ? body.requestId : null,
    });
    if (!result.ok) {
      const status = result.code === "NOT_FOUND" ? 404 : result.code === "AI_REQUIRED" ? 409 : result.code === "BUSY" ? 429 : 503;
      return NextResponse.json(result, { status });
    }
    return NextResponse.json(result);
  } catch (e) {
    console.error("[act]", e);
    return NextResponse.json({ ok: false, code: "INTERNAL", message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
