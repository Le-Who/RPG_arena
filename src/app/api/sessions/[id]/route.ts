import { NextResponse } from "next/server";
import { db } from "@/db";
import { gameSessions, gameTurns, memoryNodes, inventoryItems, worldLocations, quests, npcs, sceneObjects } from "@/db/schema";
import { asc, desc, eq, sql } from "drizzle-orm";
import { embeddingStats } from "@/lib/embeddings";
import { PROFILE_SPECS } from "@/lib/profiles";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await db.select().from(gameSessions).where(eq(gameSessions.id, id));
  if (!s[0]) return NextResponse.json({ error: "not found" }, { status: 404 });
  const [turnsDesc, memories, inventory, locations, questRows, npcRows, scene, emb] = await Promise.all([
    db.select().from(gameTurns).where(eq(gameTurns.sessionId, id)).orderBy(desc(gameTurns.turnNumber), desc(gameTurns.createdAt)).limit(80),
    db.select().from(memoryNodes).where(eq(memoryNodes.sessionId, id)).orderBy(desc(sql`${memoryNodes.importance} * 0.7 + ${memoryNodes.salience} * 0.3`)).limit(80),
    db.select().from(inventoryItems).where(eq(inventoryItems.sessionId, id)).orderBy(asc(inventoryItems.createdAt)),
    db.select().from(worldLocations).where(eq(worldLocations.sessionId, id)),
    db.select().from(quests).where(eq(quests.sessionId, id)).orderBy(asc(quests.createdAt)),
    db.select().from(npcs).where(eq(npcs.sessionId, id)).orderBy(desc(npcs.lastSeenTurn)),
    db.select().from(sceneObjects).where(eq(sceneObjects.sessionId, id)).orderBy(desc(sceneObjects.updatedTurn)),
    embeddingStats(id).catch(() => null),
  ]);
  const turns = turnsDesc.reverse();
  const session = s[0];
  return NextResponse.json({
    session,
    profile: PROFILE_SPECS[session.rulesProfile] ?? PROFILE_SPECS.d20,
    turns,
    memories,
    inventory,
    locations,
    quests: questRows,
    npcs: npcRows,
    sceneObjects: scene,
    embeddings: emb,
  });
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await db.delete(gameSessions).where(eq(gameSessions.id, id));
  return NextResponse.json({ ok: true });
}
