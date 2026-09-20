import { randomUUID } from "node:crypto";
import { agreementEvents } from "@/db/schema";
import { loadAgreementHistory } from "./narrative-agreements";
import { and, asc, count, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiSettings, campaignCheckpoints, checkpointForks, gameSessions, gameTurns, inventoryItems, memoryEmbeddings, memoryJobs, memoryLinks, memoryNodes, npcs, quests, sceneObjects, worldLocations } from "@/db/schema";
import { CHECKPOINT_LIMIT, type CheckpointSnapshot, type CheckpointSummary } from "./checkpoint-types";
import { assertSnapshot, remapSnapshot, snapshotChecksum, stableSerialize } from "./checkpoint-snapshot";
import { createHash } from "node:crypto";
import { assertNoRunningTurn, lockSession } from "./turn-admission";
import { HttpError } from "./http";
import { hashContent } from "./memory";
import { EMBEDDING_MODEL, DEFAULT_EMBEDDING_DIMS, formatDocument } from "./vector";
const plain = <T>(value: unknown): T => JSON.parse(JSON.stringify(value)) as T;
const chunk = <T>(rows: T[], size = 100): T[][] => Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size));
const roleOrder = sql`case when ${gameTurns.role} = 'player' then 0 else 1 end`;
export async function createCheckpoint(input: { sessionId: string; title: string; expectedTurn?: number; requestId: string }) {
  return db.transaction(async (tx) => {
    await lockSession(tx, input.sessionId);
    const [session] = await tx.select().from(gameSessions).where(eq(gameSessions.id, input.sessionId));
    if (!session) throw new HttpError(404, "NOT_FOUND", "История не найдена.");
    const [previous] = await tx.select({ id: campaignCheckpoints.id, title: campaignCheckpoints.title, turnNumber: campaignCheckpoints.turnNumber }).from(campaignCheckpoints).where(and(eq(campaignCheckpoints.sessionId, input.sessionId), eq(campaignCheckpoints.requestId, input.requestId)));
    if (previous) { if (previous.title !== input.title || (input.expectedTurn !== undefined && input.expectedTurn !== previous.turnNumber)) throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "Запрос уже использован для другой контрольной точки."); return { checkpoint: previous, replay: true }; }
    await assertNoRunningTurn(tx, input.sessionId);
    if (input.expectedTurn !== undefined && input.expectedTurn !== session.turnCount) throw new HttpError(409, "STALE_TURN", "История изменилась. Обновите сцену перед сохранением контрольной точки.");
    const [n] = await tx.select({ n: count() }).from(campaignCheckpoints).where(eq(campaignCheckpoints.sessionId, input.sessionId));
    if (n.n >= CHECKPOINT_LIMIT) throw new HttpError(409, "CHECKPOINT_LIMIT", "Доступно 12 контрольных точек на кампанию. Удалите ненужную точку — созданные из неё ветки сохранятся.");
    const turns = await tx.select().from(gameTurns).where(and(eq(gameTurns.sessionId, input.sessionId), lte(gameTurns.turnNumber, session.turnCount))).orderBy(asc(gameTurns.turnNumber), asc(roleOrder), asc(gameTurns.createdAt)).limit(2001);
    const inventory = await tx.select().from(inventoryItems).where(eq(inventoryItems.sessionId, input.sessionId)).limit(1001);
    const locations = await tx.select().from(worldLocations).where(eq(worldLocations.sessionId, input.sessionId)).limit(1001);
    const questRows = await tx.select().from(quests).where(eq(quests.sessionId, input.sessionId)).limit(1001);
    const npcRows = await tx.select().from(npcs).where(eq(npcs.sessionId, input.sessionId)).limit(1001);
    const scene = await tx.select().from(sceneObjects).where(eq(sceneObjects.sessionId, input.sessionId)).limit(1001);
    const memories = await tx.select().from(memoryNodes).where(eq(memoryNodes.sessionId, input.sessionId)).limit(1001);
    const agreements = await loadAgreementHistory(tx, input.sessionId, session.turnCount + 1);
    if (turns.length > 2000 || [inventory, locations, questRows, npcRows, scene, memories].some((rows) => rows.length > 1000)) throw new HttpError(413, "CHECKPOINT_TOO_LARGE", "История превышает лимит быстрого снимка: 2000 записей или 1000 сущностей. Данные не усекались.");
    const mids = memories.map((m) => m.id);
    const links = mids.length ? await tx.select().from(memoryLinks).where(and(inArray(memoryLinks.fromId, mids), inArray(memoryLinks.toId, mids))) : [];
    const { createdAt: _created, updatedAt: _updated, branchOrigin: _origin, ...state } = session;
    const snapshot = plain<CheckpointSnapshot>({ schemaVersion: 1, session: state, turns: turns.map((turn) => ({ ...turn, requestId: null })), inventory, locations, quests: questRows, npcs: npcRows, sceneObjects: scene, memories, links, agreements });
    assertSnapshot(snapshot);
    const [pending] = await tx.select({ n: count() }).from(memoryJobs).where(and(eq(memoryJobs.sessionId, input.sessionId), inArray(memoryJobs.status, ["pending", "processing"])));
    const [saved] = await tx.insert(campaignCheckpoints).values({ sessionId: input.sessionId, title: input.title, requestId: input.requestId, turnNumber: session.turnCount, snapshot, checksum: snapshotChecksum(snapshot), summary: { character: session.character.name, location: session.worldState.currentLocation, memories: memories.length, items: inventory.length, turns: turns.length, pendingFacts: pending.n } }).returning({ id: campaignCheckpoints.id, title: campaignCheckpoints.title, turnNumber: campaignCheckpoints.turnNumber });
    return { checkpoint: saved, replay: false };
  });
}
export async function listCheckpoints(sessionId: string): Promise<CheckpointSummary[]> {
  const [session] = await db.select({ id: gameSessions.id }).from(gameSessions).where(eq(gameSessions.id, sessionId));
  if (!session) throw new HttpError(404, "NOT_FOUND", "История не найдена.");
  const rows = await db.select({ id: campaignCheckpoints.id, sessionId: campaignCheckpoints.sessionId, title: campaignCheckpoints.title, turnNumber: campaignCheckpoints.turnNumber, summary: campaignCheckpoints.summary, createdAt: campaignCheckpoints.createdAt }).from(campaignCheckpoints).where(eq(campaignCheckpoints.sessionId, sessionId)).orderBy(desc(campaignCheckpoints.turnNumber), desc(campaignCheckpoints.createdAt));
  const branches = rows.length ? await db.select({ checkpointId: checkpointForks.checkpointId, id: gameSessions.id, title: gameSessions.title, turnCount: gameSessions.turnCount }).from(checkpointForks).innerJoin(gameSessions, eq(checkpointForks.branchId, gameSessions.id)).where(inArray(checkpointForks.checkpointId, rows.map((r) => r.id))) : [];
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), branches: branches.filter((b) => b.checkpointId === r.id).map(({ id, title, turnCount }) => ({ id, title, turnCount })) }));
}
export async function deleteCheckpoint(sessionId: string, checkpointId: string) {
  await db.transaction(async (tx) => {
    await lockSession(tx, sessionId);
    const removed = await tx.delete(campaignCheckpoints).where(and(eq(campaignCheckpoints.id, checkpointId), eq(campaignCheckpoints.sessionId, sessionId))).returning({ id: campaignCheckpoints.id });
    if (!removed.length) throw new HttpError(404, "NOT_FOUND", "Контрольная точка не найдена.");
  });
}
export async function forkCheckpoint(input: { sessionId: string; checkpointId: string; requestId: string; title: string }) {
  return db.transaction(async (tx) => {
    await lockSession(tx, input.sessionId);
    const [checkpoint] = await tx.select().from(campaignCheckpoints).where(and(eq(campaignCheckpoints.id, input.checkpointId), eq(campaignCheckpoints.sessionId, input.sessionId)));
    if (!checkpoint) throw new HttpError(404, "NOT_FOUND", "Контрольная точка не найдена в этой кампании.");
    const inputHash = createHash("sha256").update(stableSerialize({ checkpointId: input.checkpointId, title: input.title })).digest("hex");
    const [previous] = await tx.select().from(checkpointForks).where(and(eq(checkpointForks.checkpointId, checkpoint.id), eq(checkpointForks.requestId, input.requestId)));
    if (previous) {
      if (previous.inputHash !== inputHash) throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "Этот запрос уже использован для другой ветки.");
      if (!previous.branchId) throw new HttpError(410, "BRANCH_DELETED", "Ветка этого запроса уже удалена. Создайте новую с новым requestId.");
      const [branch] = await tx.select().from(gameSessions).where(eq(gameSessions.id, previous.branchId));
      return { session: branch, replay: true };
    }
    if (snapshotChecksum(checkpoint.snapshot) !== checkpoint.checksum) throw new HttpError(409, "SNAPSHOT_INTEGRITY", "Контрольная сумма не совпадает. Ветка не создана.");
    assertSnapshot(checkpoint.snapshot);
    const branchId = randomUUID(); const copy = remapSnapshot(checkpoint.snapshot, branchId);
    const [source] = await tx.select({ ownerId: gameSessions.ownerId }).from(gameSessions).where(eq(gameSessions.id, input.sessionId));
    const [session] = await tx.insert(gameSessions).values({ ...copy.session, ownerId: source.ownerId, visibility: "private", id: branchId, title: input.title, status: "active", branchOrigin: { sessionId: input.sessionId, sessionTitle: checkpoint.snapshot.session.title, checkpointId: checkpoint.id, checkpointTitle: checkpoint.title, turn: checkpoint.turnNumber } }).returning();
    for (const rows of chunk(copy.inventory.map((r) => ({ ...r, createdAt: new Date(r.createdAt) })))) await tx.insert(inventoryItems).values(rows);
    for (const rows of chunk(copy.locations)) await tx.insert(worldLocations).values(rows);
    for (const rows of chunk(copy.quests.map((r) => ({ ...r, createdAt: new Date(r.createdAt) })))) await tx.insert(quests).values(rows);
    for (const rows of chunk(copy.npcs.map((r) => ({ ...r, createdAt: new Date(r.createdAt) })))) await tx.insert(npcs).values(rows);
    for (const rows of chunk(copy.sceneObjects.map((r) => ({ ...r, createdAt: new Date(r.createdAt) })))) await tx.insert(sceneObjects).values(rows);
    for (const rows of chunk(copy.turns.map((r) => ({ ...r, requestId: null, createdAt: new Date(r.createdAt) })))) await tx.insert(gameTurns).values(rows);
    for (const revision of [...(copy.agreements ?? [])].sort((a, b) => a.turnNumber - b.turnNumber || a.version - b.version)) await tx.insert(agreementEvents).values(revision);
    for (const rows of chunk(copy.memories.map((r) => ({ ...r, parentId: null, contentHash: hashContent(r.layer, r.category, r.title, r.content), createdAt: new Date(r.createdAt), updatedAt: new Date(r.updatedAt) })))) await tx.insert(memoryNodes).values(rows);
    for (const memory of copy.memories) if (memory.parentId) await tx.update(memoryNodes).set({ parentId: memory.parentId }).where(and(eq(memoryNodes.id, memory.id), eq(memoryNodes.sessionId, branchId)));
    for (const rows of chunk(copy.links)) await tx.insert(memoryLinks).values(rows);
    const [settings] = await tx.select({ dims: aiSettings.embeddingDims }).from(aiSettings).where(eq(aiSettings.id, source.ownerId ?? "unowned"));
    const dims = settings?.dims ?? DEFAULT_EMBEDDING_DIMS;
    for (const rows of chunk(copy.memories.map((r) => ({ memoryNodeId: r.id, sessionId: branchId, model: EMBEDDING_MODEL, dims, contentHash: hashContent(EMBEDDING_MODEL, String(dims), formatDocument(r.title, r.content)), status: "pending" as const })))) await tx.insert(memoryEmbeddings).values(rows);
    await tx.insert(checkpointForks).values({ checkpointId: checkpoint.id, branchId, requestId: input.requestId, inputHash });
    return { session, replay: false };
  });
}
