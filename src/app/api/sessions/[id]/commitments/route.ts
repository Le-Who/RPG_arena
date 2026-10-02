import { after, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { gameSessions } from "@/db/schema";
import type { WorldState } from "@/db/schema";
import { currentProfileId } from "@/lib/identity";
import { withCampaignAccess } from "@/lib/campaign-access";
import { httpError, readJsonObject } from "@/lib/http";
import { lockSession, assertNoRunningTurn } from "@/lib/turn-admission";
import { parseCommitmentEdit, resolveCommitment } from "@/lib/world-commitments";
import { readLife } from "@/lib/world-life";
import { writeStateEvents } from "@/lib/memory";
import { runMemoryCycle } from "@/lib/background";

export const dynamic = "force-dynamic";

/**
 * WORLD-3b (2.10): владелец отмечает или исправляет исход договорённости — состоялась, неявка,
 * отмена, перенос, возврат в открытые. Правка идёт под блокировкой сессии вне хода, проверяет версию
 * записи, получает `source: "owner"` в истории и обновляет память тем же ключом сущности.
 */
async function handlePATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const ownerId = await currentProfileId();
    const edit = parseCommitmentEdit(await readJsonObject(req));
    if (!edit) return NextResponse.json({ error: "Некорректная отметка договорённости" }, { status: 400 });
    const outcome = await db.transaction(async (tx) => {
      await lockSession(tx, id);
      const [session] = await tx.select({ worldState: gameSessions.worldState, turnCount: gameSessions.turnCount, ownerId: gameSessions.ownerId }).from(gameSessions).where(eq(gameSessions.id, id));
      if (!session || session.ownerId !== ownerId) return { status: 404 as const, error: "Кампания не найдена" };
      await assertNoRunningTurn(tx, id);
      const turn = session.turnCount ?? 0;
      const result = await resolveCommitment({ world: session.worldState as WorldState, edit, turn });
      if (!result.ok) return { status: result.code === "STALE_COMMITMENT" ? 409 as const : result.code === "NOT_FOUND" ? 404 as const : 400 as const, error: result.error, code: result.code };
      await tx.update(gameSessions).set({ worldState: result.world, updatedAt: new Date() }).where(eq(gameSessions.id, id));
      const changed = await writeStateEvents(id, result.events, turn, tx, { lockHeld: true });
      return { status: 200 as const, world: result.world, summary: result.summary, changed };
    });
    if (outcome.status !== 200) return NextResponse.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
    if (outcome.changed.length) after(async () => { try { await runMemoryCycle({ sessionId: id, source: "after" }); } catch { /* durable queue remains */ } });
    return NextResponse.json({ ok: true, summary: outcome.summary, commitments: readLife(outcome.world).commitments, worldState: outcome.world });
  } catch (error) { return httpError(error); }
}

export const PATCH = withCampaignAccess("owner", handlePATCH);
