import { and, count, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { campaignCheckpoints, gameSessions, memoryEmbeddings, memoryJobs, turnRequests, workerHeartbeats } from "@/db/schema";
import { getAIConfig } from "./ai-settings";
import { currentProfileId } from "./identity";
import { summarizeQueueHealth } from "./queue-health";
export async function getSystemStatus() {
  const ownerId = await currentProfileId();
  const owned = db.select({ id: gameSessions.id }).from(gameSessions).where(eq(gameSessions.ownerId, ownerId));
  const cfg = await getAIConfig();
  const [semantic, embeddings, active, completed, checkpointCount, recent, beats, campaigns, staleSpace, oldest, oldestSemantic] = await Promise.all([
    db.select({ status: memoryJobs.status, n: count() }).from(memoryJobs).where(inArray(memoryJobs.sessionId, owned)).groupBy(memoryJobs.status),
    db.select({ status: memoryEmbeddings.status, n: count() }).from(memoryEmbeddings).where(inArray(memoryEmbeddings.sessionId, owned)).groupBy(memoryEmbeddings.status),
    db.select({ n: count() }).from(turnRequests).where(and(inArray(turnRequests.sessionId, owned), eq(turnRequests.status, "running"), gt(turnRequests.leaseExpiresAt, new Date()))),
    db.select({ n: count() }).from(turnRequests).where(and(inArray(turnRequests.sessionId, owned), eq(turnRequests.status, "completed"))),
    db.select({ n: count() }).from(campaignCheckpoints).where(inArray(campaignCheckpoints.sessionId, owned)),
    db.select({ id: memoryJobs.id, sessionId: memoryJobs.sessionId, sessionTitle: gameSessions.title, turnNumber: memoryJobs.turnNumber, status: memoryJobs.status, attempts: memoryJobs.attempts, factsCount: memoryJobs.factsCount, error: memoryJobs.error, updatedAt: memoryJobs.updatedAt, nextAttemptAt: memoryJobs.nextAttemptAt }).from(memoryJobs).innerJoin(gameSessions, eq(memoryJobs.sessionId, gameSessions.id)).where(eq(gameSessions.ownerId, ownerId)).orderBy(desc(memoryJobs.updatedAt)).limit(12),
    db.select().from(workerHeartbeats).where(inArray(workerHeartbeats.id, ["memory:worker", `memory:manual:${ownerId}`])),
    db.select({ n: count() }).from(gameSessions).where(eq(gameSessions.ownerId, ownerId)),
    db.select({ n: count() }).from(memoryEmbeddings).where(and(inArray(memoryEmbeddings.sessionId, owned), sql`(${memoryEmbeddings.model} <> ${cfg.embeddingModel} or ${memoryEmbeddings.dims} <> ${cfg.embeddingDims})`)),
    db.select({ oldest: sql<string | null>`min(${memoryEmbeddings.createdAt})` }).from(memoryEmbeddings).where(and(inArray(memoryEmbeddings.sessionId, owned), inArray(memoryEmbeddings.status, ["pending", "processing"]))),
    db.select({ oldest: sql<string | null>`min(${memoryJobs.createdAt})` }).from(memoryJobs).where(and(inArray(memoryJobs.sessionId, owned), inArray(memoryJobs.status, ["pending", "processing"]))),
  ]);
  const group = (rows: { status: string; n: number }[]) => Object.fromEntries(rows.map((r) => [r.status, r.n]));
  const worker = beats.find((b) => b.id === "memory:worker");
  const online = !!worker && worker.status !== "stopped" && Date.now() - worker.lastSeenAt.getTime() < 120000;
  return {
    version: "2.5", checkedAt: new Date().toISOString(), database: "connected" as const,
    capabilities: { generation: cfg.canUseLive, embeddings: cfg.keys.length > 0 && cfg.embeddingsEnabled, extraction: cfg.canUseLive && cfg.semanticExtractionEnabled, hasKeys: cfg.keys.length > 0, model: cfg.embeddingModel, dims: cfg.embeddingDims },
    turns: { running: active[0].n, completed: completed[0].n }, checkpoints: checkpointCount[0].n, campaigns: campaigns[0].n,
    queues: { semantic: group(semantic), embeddings: group(embeddings), staleSpace: staleSpace[0].n, ...summarizeQueueHealth([semantic, embeddings], [oldest[0]?.oldest, oldestSemantic[0]?.oldest]) },
    worker: { online, heartbeatAgeMs: worker ? Math.max(0, Date.now() - worker.lastSeenAt.getTime()) : null, status: worker?.status ?? "not-started", lastSeenAt: worker?.lastSeenAt.toISOString() ?? null, report: null },
    lastManual: beats.find((b) => b.id === `memory:manual:${ownerId}`)?.lastSeenAt.toISOString() ?? null,
    recentJobs: recent.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString(), nextAttemptAt: r.nextAttemptAt.toISOString() })),
  };
}
export type SystemStatus = Awaited<ReturnType<typeof getSystemStatus>>;
export async function retryFailedMemoryJobs() {
  const now = new Date();
  const owned = db.select({ id: gameSessions.id }).from(gameSessions).where(eq(gameSessions.ownerId, await currentProfileId()));
  return db.transaction(async (tx) => {
    const semantic = await tx.update(memoryJobs).set({ status: "pending", attempts: 0, error: null, leaseToken: null, leaseExpiresAt: null, nextAttemptAt: now, updatedAt: now }).where(and(inArray(memoryJobs.sessionId, owned), eq(memoryJobs.status, "failed"))).returning({ id: memoryJobs.id });
    const embeddings = await tx.update(memoryEmbeddings).set({ status: "pending", attempts: 0, error: "", leaseToken: null, leaseExpiresAt: null, nextAttemptAt: now, updatedAt: now }).where(and(inArray(memoryEmbeddings.sessionId, owned), eq(memoryEmbeddings.status, "failed"))).returning({ id: memoryEmbeddings.id });
    return { queued: semantic.length + embeddings.length };
  });
}
