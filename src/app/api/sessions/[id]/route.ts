import { normalizeStoryShape } from "@/lib/world-life";
import type { WorldState } from "@/db/schema";
import { withCampaignAccess } from "@/lib/campaign-access";
import { after, NextResponse } from "next/server";
import { prewarmSessionChoices } from "@/lib/choice-prewarm";
import { db } from "@/db";
import { gameSessions, gameTurns, memoryNodes, inventoryItems, worldLocations, quests, npcs, sceneObjects } from "@/db/schema";
import { asc, desc, eq, sql } from "drizzle-orm";
import { embeddingStats } from "@/lib/embeddings";
import { lockSession, assertNoRunningTurn } from "@/lib/turn-admission";
import { httpError, readJsonObject } from "@/lib/http";
import { PROFILE_SPECS } from "@/lib/profiles";
import { currentProfileId } from "@/lib/identity";

export const dynamic = "force-dynamic";

async function handleGET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profileId = await currentProfileId();
  const requested = Number(new URL(req.url).searchParams.get("memories"));
  const memoryLimit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.trunc(requested), 200) : 80;
  try { return await db.transaction(async (tx) => {
  await lockSession(tx, id);
  const s = await tx.select().from(gameSessions).where(eq(gameSessions.id, id));
  if (!s[0]) return NextResponse.json({ error: "not found" }, { status: 404 });
  const [turnsDesc, memories, inventory, locations, questRows, npcRows, scene, emb] = await Promise.all([
    tx.select().from(gameTurns).where(eq(gameTurns.sessionId, id)).orderBy(desc(gameTurns.turnNumber), desc(sql`case when ${gameTurns.role} = 'player' then 0 else 1 end`), desc(gameTurns.createdAt)).limit(80),
    tx.select().from(memoryNodes).where(eq(memoryNodes.sessionId, id)).orderBy(desc(sql`${memoryNodes.importance} * 0.7 + ${memoryNodes.salience} * 0.3`)).limit(memoryLimit),
    tx.select().from(inventoryItems).where(eq(inventoryItems.sessionId, id)).orderBy(asc(inventoryItems.createdAt)),
    tx.select().from(worldLocations).where(eq(worldLocations.sessionId, id)),
    tx.select().from(quests).where(eq(quests.sessionId, id)).orderBy(asc(quests.createdAt)),
    tx.select().from(npcs).where(eq(npcs.sessionId, id)).orderBy(desc(npcs.lastSeenTurn)),
    tx.select().from(sceneObjects).where(eq(sceneObjects.sessionId, id)).orderBy(desc(sceneObjects.updatedTurn)),
    embeddingStats(id, tx),
  ]);
  const turns = turnsDesc.reverse();
  const session = s[0];
  if (session.ownerId === profileId) after(() => prewarmSessionChoices(id));
  return NextResponse.json({
    isOwner: session.ownerId === profileId,
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
  }); } catch (error) { return httpError(error); }
}

async function handleDELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await db.transaction(async (tx) => { await lockSession(tx, id); await assertNoRunningTurn(tx, id); await tx.delete(gameSessions).where(eq(gameSessions.id, id)); });
    return NextResponse.json({ ok: true });
  } catch (error) { return httpError(error); }
}

async function handlePATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
  const body = await readJsonObject(req);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Некорректный запрос" }, { status: 400 });
  const patch: { title?: string; status?: string; visibility?: "private" | "public"; updatedAt: Date } = { updatedAt: new Date() };
  if (body.visibility !== undefined) {
    if (body.visibility !== "private" && body.visibility !== "public") return NextResponse.json({ error: "Некорректный доступ" }, { status: 400 });
    patch.visibility = body.visibility;
  }
  if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim().slice(0, 80);
  if (typeof body.status === "string" && ["active", "archived", "paused", "finished"].includes(body.status)) patch.status = body.status;
  const storyInput = body.storyShape && typeof body.storyShape === "object" && !Array.isArray(body.storyShape) ? body.storyShape as Record<string, unknown> : null;
  if (!patch.title && !patch.status && !patch.visibility && !storyInput) return NextResponse.json({ error: "Нет изменений" }, { status: 400 });
  const row = await db.transaction(async (tx) => {
    await lockSession(tx, id);
    await assertNoRunningTurn(tx, id);
    if (storyInput) {
      // NARR-7: форма истории редактируется владельцем; статус завершения меняется только событиями хода
      // или явным «продолжить после финала» (reopen).
      const [current] = await tx.select({ worldState: gameSessions.worldState }).from(gameSessions).where(eq(gameSessions.id, id));
      if (!current) return [];
      const world = current.worldState as WorldState;
      const previous = normalizeStoryShape(world.story, world);
      const next = normalizeStoryShape({ ...previous, ...storyInput, status: storyInput.reopen === true ? "ongoing" : previous.status }, world);
      if (storyInput.reopen !== true && previous.resolvedTurn !== undefined) next.resolvedTurn = previous.resolvedTurn;
      if (previous.epilogue && storyInput.reopen !== true) next.epilogue = previous.epilogue;
      return tx.update(gameSessions).set({ ...patch, worldState: { ...world, story: next } }).where(eq(gameSessions.id, id)).returning();
    }
    return tx.update(gameSessions).set(patch).where(eq(gameSessions.id, id)).returning();
  });
  return row[0] ? NextResponse.json({ session: row[0] }) : NextResponse.json({ error: "Кампания не найдена" }, { status: 404 });
  } catch (error) { return httpError(error); }
}

export const GET = withCampaignAccess("read", handleGET);

export const DELETE = withCampaignAccess("owner", handleDELETE);

export const PATCH = withCampaignAccess("owner", handlePATCH);
