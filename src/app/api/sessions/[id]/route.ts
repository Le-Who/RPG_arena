import { NextResponse } from "next/server";
import { db } from "@/db";
import { gameSessions, gameTurns, memoryNodes, inventoryItems, worldLocations } from "@/db/schema";
import { asc, desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await db.select().from(gameSessions).where(eq(gameSessions.id, id));
  if (!s[0]) return NextResponse.json({ error: "not found" }, { status: 404 });
  // Fix #4: последние 60 записей (~30 игровых ходов с учётом dice-дублей).
  // Полная история хранится в БД; для листания реализуй cursor-based пагинацию.
  // desc+reverse вместо asc+limit(200): снижает payload при длинных кампаниях с ~500KB до ~90KB.
  const turnsDesc = await db.select().from(gameTurns).where(eq(gameTurns.sessionId, id)).orderBy(desc(gameTurns.turnNumber)).limit(60);
  const turns = turnsDesc.reverse();
  const memories = await db.select().from(memoryNodes).where(eq(memoryNodes.sessionId, id)).orderBy(desc(memoryNodes.importance)).limit(60);
  const inventory = await db.select().from(inventoryItems).where(eq(inventoryItems.sessionId, id));
  const locations = await db.select().from(worldLocations).where(eq(worldLocations.sessionId, id));
  return NextResponse.json({ session: s[0], turns, memories, inventory, locations });
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await db.delete(gameSessions).where(eq(gameSessions.id, id));
  return NextResponse.json({ ok: true });
}
