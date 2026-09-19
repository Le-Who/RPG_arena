import { and, count, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { campaignCheckpoints, gameSessions, memoryEmbeddings, memoryJobs, turnRequests, workerHeartbeats } from "@/db/schema";
import { getAIConfig } from "./ai-settings";
export async function getSystemStatus() {
  const cfg = await getAIConfig();
  const [semantic, embeddings, active, completed, checkpointCount, recent, beats, campaigns, staleSpace, oldest] = await Promise.all([
    db.select({ status: memoryJobs.status, n: count() }).from(memoryJobs).groupBy(memoryJobs.status),
    db.select({ status: memoryEmbeddings.status, n: count() }).from(memoryEmbeddings).groupBy(memoryEmbeddings.status),
    db.select({ n: count() }).from(turnRequests).where(and(eq(turnRequests.status, "running"), gt(turnRequests.leaseExpiresAt, new Date()))),
    db.select({ n: count() }).from(turnRequests).where(eq(turnRequests.status, "completed")),
    db.select({ n: count() }).from(campaignCheckpoints),
    db.select({ id: memoryJobs.id, sessionId: memoryJobs.sessionId, sessionTitle: gameSessions.title, turnNumber: memoryJobs.turnNumber, status: memoryJobs.status, attempts: memoryJobs.attempts, factsCount: memoryJobs.factsCount, error: memoryJobs.error, updatedAt: memoryJobs.updatedAt, nextAttemptAt: memoryJobs.nextAttemptAt }).from(memoryJobs).innerJoin(gameSessions, eq(memoryJobs.sessionId, gameSessions.id)).orderBy(desc(memoryJobs.updatedAt)).limit(12),
    db.select().from(workerHeartbeats),
    db.select({ n: count() }).from(gameSessions),
    db.select({ n: count() }).from(memoryEmbeddings).where(sql`${memoryEmbeddings.model} <> ${cfg.embeddingModel} or ${memoryEmbeddings.dims} <> ${cfg.embeddingDims}`),
    db.select({ oldest: sql<string | null>`min(${memoryEmbeddings.createdAt})` }).from(memoryEmbeddings).where(inArray(memoryEmbeddings.status, ["pending", "processing"])),
  ]);
  const group = (rows: { status: string; n: number }[]) => Object.fromEntries(rows.map((r) => [r.status, r.n]));
  const worker = beats.find((b) => b.id === "memory:worker");
  const online = !!worker && worker.status !== "stopped" && Date.now() - worker.lastSeenAt.getTime() < 120000;
  return {
    version: "2.5", checkedAt: new Date().toISOString(), database: "connected" as const,
    capabilities: { generation: cfg.canUseLive, embeddings: cfg.keys.length > 0 && cfg.embeddingsEnabled, extraction: cfg.canUseLive && cfg.semanticExtractionEnabled, hasKeys: cfg.keys.length > 0, model: cfg.embeddingModel, dims: cfg.embeddingDims },
    turns: { running: active[0].n, completed: completed[0].n }, checkpoints: checkpointCount[0].n, campaigns: campaigns[0].n,
    queues: { semantic: group(semantic), embeddings: group(embeddings), staleSpace: staleSpace[0].n, oldestPendingAt: oldest[0]?.oldest ?? null },
    worker: { online, status: worker?.status ?? "not-started", lastSeenAt: worker?.lastSeenAt.toISOString() ?? null, report: worker?.report ?? null },
    lastManual: beats.find((b) => b.id === "memory:manual")?.lastSeenAt.toISOString() ?? null,
    recentJobs: recent.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString(), nextAttemptAt: r.nextAttemptAt.toISOString() })),
  };
}
export type SystemStatus = Awaited<ReturnType<typeof getSystemStatus>>;
export async function retryFailedMemoryJobs() {
  const now = new Date();
  return db.transaction(async (tx) => {
    const semantic = await tx.update(memoryJobs).set({ status: "pending", attempts: 0, error: null, leaseToken: null, leaseExpiresAt: null, nextAttemptAt: now, updatedAt: now }).where(eq(memoryJobs.status, "failed")).returning({ id: memoryJobs.id });
    const embeddings = await tx.update(memoryEmbeddings).set({ status: "pending", attempts: 0, error: "", leaseToken: null, leaseExpiresAt: null, nextAttemptAt: now, updatedAt: now }).where(eq(memoryEmbeddings.status, "failed")).returning({ id: memoryEmbeddings.id });
    return { queued: semantic.length + embeddings.length };
  });
}
