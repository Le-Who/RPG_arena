// NARR-9: «Ранее в истории» — детерминированное резюме из подтверждённого состояния и памяти.
// Никаких вызовов AI: работает без ключей; сохранённая память всё же может быть устаревшей.
import { NextResponse } from "next/server";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/db";
import { gameSessions, gameTurns, memoryNodes, npcs, quests, type CharacterState, type WorldState } from "@/db/schema";
import { withCampaignAccess } from "@/lib/campaign-access";
import { httpError } from "@/lib/http";
import { buildRecap } from "@/lib/recap";

export const dynamic = "force-dynamic";

async function handleGET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const recap = await db.transaction(async tx => {
      const [session] = await tx.select().from(gameSessions).where(eq(gameSessions.id, id));
      if (!session) return null;
      const memoryColumns = { layer: memoryNodes.layer, category: memoryNodes.category, title: memoryNodes.title, content: memoryNodes.content, importance: memoryNodes.importance, turnTo: memoryNodes.turnTo, sourceTurn: memoryNodes.sourceTurn };
      const [chronicle, episodes, questRows, npcRows, recent] = await Promise.all([
        tx.select(memoryColumns).from(memoryNodes).where(and(eq(memoryNodes.sessionId, id), eq(memoryNodes.layer, "chronicle"))).orderBy(desc(memoryNodes.turnTo)).limit(4),
        tx.select(memoryColumns).from(memoryNodes).where(and(eq(memoryNodes.sessionId, id), eq(memoryNodes.layer, "episodic"), gte(memoryNodes.importance, 55))).orderBy(desc(memoryNodes.sourceTurn), desc(memoryNodes.turnTo)).limit(24),
        tx.select({ title: quests.title, status: quests.status, progress: quests.progress, isMain: quests.isMain }).from(quests).where(eq(quests.sessionId, id)),
        tx.select({ name: npcs.name, role: npcs.role, relation: npcs.relation, status: npcs.status, lastSeenTurn: npcs.lastSeenTurn, lastLocation: npcs.lastLocation }).from(npcs).where(eq(npcs.sessionId, id)),
        tx.select({ turnNumber: gameTurns.turnNumber, role: gameTurns.role, content: gameTurns.content, createdAt: gameTurns.createdAt }).from(gameTurns).where(and(eq(gameTurns.sessionId, id), inArray(gameTurns.role, ["player", "narrator"]))).orderBy(desc(gameTurns.turnNumber), desc(gameTurns.createdAt)).limit(4),
      ]);
      return buildRecap({
        title: session.title, rulesProfile: session.rulesProfile, character: session.character as CharacterState, world: session.worldState as WorldState,
        turnCount: session.turnCount, memories: [...chronicle, ...episodes], quests: questRows, npcs: npcRows,
        recentTurns: recent.reverse(), updatedAt: session.updatedAt,
      });
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    if (!recap) return NextResponse.json({ error: "Кампания не найдена" }, { status: 404 });
    return NextResponse.json({ recap });
  } catch (error) { return httpError(error); }
}

export const GET = withCampaignAccess("read", handleGET);
