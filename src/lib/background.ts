import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiSettings, gameSessions, memoryEmbeddings, workerHeartbeats } from "@/db/schema";
import { sessionOwnerId } from "./campaign-access";
import { getAIConfig } from "./ai-settings";
import { processSemanticJob } from "./memory-jobs";
import { indexPendingEmbeddings } from "./embeddings";
export type MemoryCycleReport = { extracted: number; indexed: number; failed: number; elapsedMs: number; processed: number; paused: boolean };
export async function workerHeartbeat(source: "worker" | "manual" | "after", status: string, report?: MemoryCycleReport, ownerId?: string) {
  const id = source === "worker" ? "memory:worker" : `memory:${source}:${ownerId ?? "none"}`;
  await db.insert(workerHeartbeats).values({ id, status, lastSeenAt: new Date(), report: report ?? null }).onConflictDoUpdate({ target: workerHeartbeats.id, set: { status, lastSeenAt: new Date(), ...(report ? { report } : {}) } });
}
/** A bounded tick shared by the CLI, request fast path and manual UI action. */
export async function runMemoryCycle(opts: { sessionId?: string; ownerId?: string; source?: "worker" | "manual" | "after" } = {}): Promise<MemoryCycleReport> {
  const started = Date.now(); const source = opts.source ?? "after";
  const report: MemoryCycleReport = { extracted: 0, indexed: 0, failed: 0, elapsedMs: 0, processed: 0, paused: false };
  let sessionId = opts.sessionId;
  let ownerId = opts.ownerId;
  try {
    if (!sessionId) {
      // Pick a ready campaign first, then load only its owner's credentials.
      const [next] = await db.select({ id: gameSessions.id, ownerId: gameSessions.ownerId }).from(gameSessions)
        .innerJoin(aiSettings, eq(aiSettings.id, gameSessions.ownerId))
        .where(and(ownerId ? eq(gameSessions.ownerId, ownerId) : undefined,
          sql`jsonb_array_length(coalesce(${aiSettings.keys}, '[]'::jsonb)) > 0`,
          sql`(
            (${aiSettings.useLiveAI} and ${aiSettings.semanticExtractionEnabled} and exists (
              select 1 from memory_jobs j where j.session_id = ${gameSessions.id} and
              ((j.status = 'pending' and j.next_attempt_at <= now()) or (j.status = 'processing' and j.lease_expires_at <= now()))
            )) or (${aiSettings.embeddingsEnabled} and exists (
              select 1 from memory_embeddings e where e.session_id = ${gameSessions.id} and e.model = ${aiSettings.embeddingModel} and e.dims = ${aiSettings.embeddingDims} and
              ((e.status = 'pending' and e.next_attempt_at <= now()) or (e.status = 'processing' and e.lease_expires_at <= now()))
            ))
          )`))
        .orderBy(sql`least(
          (select min(j.next_attempt_at) from memory_jobs j where j.session_id = ${gameSessions.id} and j.status in ('pending', 'processing')),
          (select min(e.next_attempt_at) from memory_embeddings e where e.session_id = ${gameSessions.id} and e.status in ('pending', 'processing'))
        )`).limit(1);
      sessionId = next?.id;
      ownerId = next?.ownerId ?? ownerId;
    }
    if (!sessionId) {
      report.elapsedMs = Date.now() - started;
      await workerHeartbeat(source, "idle", report, ownerId);
      return report;
    }
    const actualOwner = await sessionOwnerId(sessionId);
    if (ownerId && actualOwner !== ownerId) throw new Error("Memory campaign owner mismatch");
    ownerId = actualOwner;
    const cfg = await getAIConfig(ownerId);
    report.paused = !cfg.keys.length || (!cfg.embeddingsEnabled && (!cfg.canUseLive || !cfg.semanticExtractionEnabled));
    await workerHeartbeat(source, report.paused ? "paused" : "running", undefined, ownerId);
    if (!report.paused) {
      const semantic = await processSemanticJob({ sessionId, cfg });
      report.extracted = semantic.extracted; report.failed = semantic.failed; report.processed = semantic.processed;
      if (cfg.embeddingsEnabled) {
        const [next] = await db.select({ sessionId: memoryEmbeddings.sessionId }).from(memoryEmbeddings).where(and(
          eq(memoryEmbeddings.sessionId, sessionId),
          eq(memoryEmbeddings.model, cfg.embeddingModel), eq(memoryEmbeddings.dims, cfg.embeddingDims),
          or(and(eq(memoryEmbeddings.status, "pending"), lte(memoryEmbeddings.nextAttemptAt, new Date())), and(eq(memoryEmbeddings.status, "processing"), lte(memoryEmbeddings.leaseExpiresAt, new Date()))),
        )).orderBy(asc(memoryEmbeddings.nextAttemptAt), asc(memoryEmbeddings.updatedAt)).limit(1);
        if (next) { const batch = await indexPendingEmbeddings({ sessionId: next.sessionId, keys: cfg.keys, model: cfg.embeddingModel, dims: cfg.embeddingDims, limit: 32 }); report.indexed = batch.indexed; report.failed += batch.failed; }
      }
    }
    report.elapsedMs = Date.now() - started;
    await workerHeartbeat(source, report.paused ? "paused" : "idle", report, ownerId);
    return report;
  } catch (error) {
    await workerHeartbeat(source, "error", undefined, ownerId).catch(() => {});
    throw error;
  }
}
