import { createHash } from "node:crypto";
import { agreementEvents } from "@/db/schema";
import { loadAgreementHistory } from "./narrative-agreements";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiSettings, gameSessions, gameTurns, inventoryItems, memoryEmbeddings, memoryLinks, memoryNodes, npcs, quests, sceneObjects, worldLocations } from "@/db/schema";
import type { CheckpointSnapshot } from "./checkpoint-types";
import { assertSnapshot, remapSnapshot } from "./checkpoint-snapshot";
import { canAccessCampaign } from "./campaign-policy";
import { assertNoRunningTurn, lockSession } from "./turn-admission";
import { HttpError, requestKey, requireUuid } from "./http";
import { hashContent } from "./memory";
import { DEFAULT_EMBEDDING_DIMS, EMBEDDING_MODEL, formatDocument } from "./vector";

const chunk = <T>(rows: T[], size = 100): T[][] => Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size));

/** Copy only saved campaign data. Credentials, billing, jobs and checkpoints stay with their owner. */
export async function copyCampaign(input: { sessionId: string; profileId: string; requestId: string }) {
  requireUuid(input.sessionId);
  if (!requestKey(input.requestId)) throw new HttpError(400, "INVALID_INPUT", "Для копирования нужен requestId.");
  // A stable, owner-scoped destination makes concurrent retries resolve to one private campaign.
  const bytes = createHash("sha256").update(JSON.stringify(["campaign-copy:v1", input.sessionId, input.profileId, input.requestId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  const copyId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as const;

  return db.transaction(async tx => {
    await lockSession(tx, input.sessionId);
    const [source] = await tx.select().from(gameSessions).where(eq(gameSessions.id, input.sessionId));
    // Publishing may have changed while this request waited for the campaign lock.
    if (!source || !canAccessCampaign(source, input.profileId, "read")) throw new HttpError(404, "NOT_FOUND", "Кампания не найдена.");
    const [previous] = await tx.select().from(gameSessions).where(and(eq(gameSessions.id, copyId), eq(gameSessions.ownerId, input.profileId)));
    if (previous) return { session: previous, replay: true };
    await assertNoRunningTurn(tx, input.sessionId);

    const turns = await tx.select().from(gameTurns).where(and(eq(gameTurns.sessionId, source.id), lte(gameTurns.turnNumber, source.turnCount))).orderBy(asc(gameTurns.turnNumber), asc(sql`case when ${gameTurns.role} = 'player' then 0 else 1 end`), asc(gameTurns.createdAt)).limit(2001);
    const inventory = await tx.select().from(inventoryItems).where(eq(inventoryItems.sessionId, source.id)).limit(1001);
    const locations = await tx.select().from(worldLocations).where(eq(worldLocations.sessionId, source.id)).limit(1001);
    const questRows = await tx.select().from(quests).where(eq(quests.sessionId, source.id)).limit(1001);
    const npcRows = await tx.select().from(npcs).where(eq(npcs.sessionId, source.id)).limit(1001);
    const scene = await tx.select().from(sceneObjects).where(eq(sceneObjects.sessionId, source.id)).limit(1001);
    const memories = await tx.select().from(memoryNodes).where(eq(memoryNodes.sessionId, source.id)).limit(1001);
    const agreements = await loadAgreementHistory(tx, source.id, source.turnCount + 1);
    if (turns.length > 2000 || [inventory, locations, questRows, npcRows, scene, memories].some(rows => rows.length > 1000)) throw new HttpError(413, "CHECKPOINT_TOO_LARGE", "История превышает лимит копии: 2000 записей или 1000 сущностей. Данные не усекались.");
    const mids = memories.map(memory => memory.id);
    const links = mids.length ? await tx.select().from(memoryLinks).where(and(inArray(memoryLinks.fromId, mids), inArray(memoryLinks.toId, mids))) : [];
    const { createdAt: _created, updatedAt: _updated, ownerId: _owner, visibility: _visibility, branchOrigin: _origin, ...state } = source;
    const snapshot = JSON.parse(JSON.stringify({ schemaVersion: 1, session: state, turns, inventory, locations, quests: questRows, npcs: npcRows, sceneObjects: scene, memories, links, agreements })) as CheckpointSnapshot;
    assertSnapshot(snapshot);
    const copy = remapSnapshot(snapshot, copyId);
    const [session] = await tx.insert(gameSessions).values({ ...copy.session, id: copyId, ownerId: input.profileId, visibility: "private", branchOrigin: null, title: `${source.title.slice(0, 67)} · моя копия`, status: "active" }).returning();
    for (const rows of chunk(copy.inventory.map(row => ({ ...row, createdAt: new Date(row.createdAt) })))) await tx.insert(inventoryItems).values(rows);
    for (const rows of chunk(copy.locations)) await tx.insert(worldLocations).values(rows);
    for (const rows of chunk(copy.quests.map(row => ({ ...row, createdAt: new Date(row.createdAt) })))) await tx.insert(quests).values(rows);
    for (const rows of chunk(copy.npcs.map(row => ({ ...row, createdAt: new Date(row.createdAt) })))) await tx.insert(npcs).values(rows);
    for (const rows of chunk(copy.sceneObjects.map(row => ({ ...row, createdAt: new Date(row.createdAt) })))) await tx.insert(sceneObjects).values(rows);
    for (const rows of chunk(copy.turns.map(row => ({ ...row, requestId: null, createdAt: new Date(row.createdAt) })))) await tx.insert(gameTurns).values(rows);
    for (const revision of [...(copy.agreements ?? [])].sort((a, b) => a.turnNumber - b.turnNumber || a.version - b.version)) await tx.insert(agreementEvents).values(revision);
    for (const rows of chunk(copy.memories.map(row => ({ ...row, parentId: null, contentHash: hashContent(row.layer, row.category, row.title, row.content), createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) })))) await tx.insert(memoryNodes).values(rows);
    for (const memory of copy.memories) if (memory.parentId) await tx.update(memoryNodes).set({ parentId: memory.parentId }).where(and(eq(memoryNodes.id, memory.id), eq(memoryNodes.sessionId, copyId)));
    for (const rows of chunk(copy.links)) await tx.insert(memoryLinks).values(rows);

    // Only the copying player's dimensions apply. This creates an outbox, never a provider call.
    const [settings] = await tx.select({ dims: aiSettings.embeddingDims }).from(aiSettings).where(eq(aiSettings.id, input.profileId));
    const dims = settings?.dims ?? DEFAULT_EMBEDDING_DIMS;
    for (const rows of chunk(copy.memories.map(row => ({ memoryNodeId: row.id, sessionId: copyId, model: EMBEDDING_MODEL, dims, contentHash: hashContent(EMBEDDING_MODEL, String(dims), formatDocument(row.title, row.content)), status: "pending" as const })))) await tx.insert(memoryEmbeddings).values(rows);
    return { session, replay: false };
  });
}
