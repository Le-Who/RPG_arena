import { after, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { gameSessions, npcs, worldLocations } from "@/db/schema";
import type { WorldState } from "@/db/schema";
import { currentProfileId } from "@/lib/identity";
import { withCampaignAccess } from "@/lib/campaign-access";
import { httpError, readJsonObject } from "@/lib/http";
import { lockSession, assertNoRunningTurn } from "@/lib/turn-admission";
import { editSocial, parseSocialEdit, readSocial } from "@/lib/world-social";
import { writeStateEvents } from "@/lib/memory";
import { runMemoryCycle } from "@/lib/background";

export const dynamic = "force-dynamic";

/**
 * WORLD-10: владелец уточняет распорядок и знания NPC. Правка выполняется под блокировкой
 * сессии вне хода, получает `source: "owner"` и обновляет память теми же ключами сущностей.
 */
async function handlePATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const ownerId = await currentProfileId();
    const body = await readJsonObject(req);
    const edit = parseSocialEdit(body);
    if (!edit) return NextResponse.json({ error: "Некорректная правка" }, { status: 400 });
    const outcome = await db.transaction(async (tx) => {
      await lockSession(tx, id);
      await assertNoRunningTurn(tx, id);
      const [session] = await tx.select({ worldState: gameSessions.worldState, turnCount: gameSessions.turnCount, ownerId: gameSessions.ownerId }).from(gameSessions).where(eq(gameSessions.id, id));
      if (!session || session.ownerId !== ownerId) return { status: 404 as const, error: "Кампания не найдена" };
      const [npcRows, locationRows] = await Promise.all([
        tx.select({ key: npcs.key, name: npcs.name, status: npcs.status }).from(npcs).where(eq(npcs.sessionId, id)),
        tx.select({ name: worldLocations.name }).from(worldLocations).where(eq(worldLocations.sessionId, id)),
      ]);
      const turn = session.turnCount ?? 0;
      const result = editSocial({ world: session.worldState as WorldState, npcs: npcRows, locations: locationRows, edit, turn });
      if (!result.ok) return { status: result.code === "STALE_SOCIAL" ? 409 as const : 400 as const, error: result.error, code: result.code };
      await tx.update(gameSessions).set({ worldState: result.world, updatedAt: new Date() }).where(and(eq(gameSessions.id, id)));
      const changed = await writeStateEvents(id, result.events, turn, tx, { lockHeld: true });
      return { status: 200 as const, world: result.world, summary: result.summary, changed };
    });
    if (outcome.status !== 200) return NextResponse.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
    // Вектор для новых/изменённых нод считается фоновым циклом; правка не ждёт провайдера эмбеддингов.
    if (outcome.changed.length) after(async () => { try { await runMemoryCycle({ sessionId: id, source: "after" }); } catch { /* durable queue remains */ } });
    return NextResponse.json({ ok: true, summary: outcome.summary, social: readSocial(outcome.world), worldState: outcome.world });
  } catch (error) { return httpError(error); }
}

export const PATCH = withCampaignAccess("owner", handlePATCH);
