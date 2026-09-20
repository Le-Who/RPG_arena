import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, lt, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { memoryJobs, type MemoryJobPayload } from "@/db/schema";
import { type DbTransaction, lockSession } from "./turn-admission";
import { buildExtractionSystemPrompt, callGeminiWithRotation, EXTRACTION_RESPONSE_SCHEMA } from "./gemini";
import { getAIConfig, logToken, pickModels, type AIConfig } from "./ai-settings";
import { extractJsonObject } from "./resolution";
import { layerForFactType, normalizeExtractedFacts, upsertMemoryNode } from "./memory";
import { runTypeSafePilotSafely } from "./typesafe-pilot";
import { getTypeSafePilotConfig } from "./typesafe-settings";
import { TYPE_SAFE_MODEL, verifyTypeSafeFacts } from "./typesafe";
export const MEMORY_JOB_LEASE_MS = 60_000;
export function retryDelayMs(attempt: number): number { return Math.min(300_000, 5000 * 2 ** Math.max(0, Math.min(attempt, 6))); }
export async function enqueueSemanticJob(tx: DbTransaction, input: { sessionId: string; turnNumber: number; payload: MemoryJobPayload }) {
  await tx.insert(memoryJobs).values({ sessionId: input.sessionId, turnNumber: input.turnNumber, kind: "semantic", payload: input.payload }).onConflictDoNothing({ target: [memoryJobs.sessionId, memoryJobs.turnNumber, memoryJobs.kind] });
}
export async function processSemanticJob(opts: { sessionId?: string; cfg?: AIConfig } = {}): Promise<{ processed: number; extracted: number; failed: number; delayed: boolean }> {
  const cfg = opts.cfg ?? await getAIConfig();
  if (!cfg.canUseLive || !cfg.semanticExtractionEnabled) return { processed: 0, extracted: 0, failed: 0, delayed: false };
  const token = randomUUID(); const now = new Date();
  const scope = opts.sessionId ? eq(memoryJobs.sessionId, opts.sessionId) : undefined;
  const job = await db.transaction(async (tx) => {
    await tx.update(memoryJobs).set({ status: "failed", leaseToken: null, leaseExpiresAt: null, error: "LEASE_RETRY_EXHAUSTED", updatedAt: now }).where(and(scope, eq(memoryJobs.status, "processing"), lte(memoryJobs.leaseExpiresAt, now), sql`${memoryJobs.attempts} >= 3`));
    const [row] = await tx.select().from(memoryJobs).where(and(scope, eq(memoryJobs.kind, "semantic"), lt(memoryJobs.attempts, 3), or(and(eq(memoryJobs.status, "pending"), lte(memoryJobs.nextAttemptAt, now)), and(eq(memoryJobs.status, "processing"), lte(memoryJobs.leaseExpiresAt, now))))).orderBy(asc(memoryJobs.nextAttemptAt), asc(memoryJobs.createdAt)).limit(1).for("update", { skipLocked: true });
    if (!row) return null;
    const [claimed] = await tx.update(memoryJobs).set({ status: "processing", attempts: row.attempts + 1, leaseToken: token, leaseExpiresAt: new Date(Date.now() + MEMORY_JOB_LEASE_MS), updatedAt: now }).where(eq(memoryJobs.id, row.id)).returning();
    return claimed;
  });
  if (!job) return { processed: 0, extracted: 0, failed: 0, delayed: false };
  const fenced = and(eq(memoryJobs.id, job.id), eq(memoryJobs.leaseToken, token), eq(memoryJobs.status, "processing"));
  try {
    const { models } = await pickModels("fast", cfg);
    if (!models.length) {
      await db.update(memoryJobs).set({ status: "pending", attempts: job.attempts - 1, leaseToken: null, leaseExpiresAt: null, error: "DAILY_LIMIT", nextAttemptAt: new Date(Date.now() + 60000), updatedAt: new Date() }).where(fenced);
      return { processed: 0, extracted: 0, failed: 0, delayed: true };
    }
    const response = await callGeminiWithRotation({ keys: cfg.keys, models, system: buildExtractionSystemPrompt(job.payload.profileCanon, job.payload.knownDigest), user: `Действие игрока (намерение, не доказательство): ${job.payload.playerAction}\n\nПодтверждённый ответ рассказчика:\n${job.payload.narration}`, maxTokens: 1000, temperature: 0.2, responseSchema: EXTRACTION_RESPONSE_SCHEMA, timeoutMs: 15000,
      onAttempt: async (attempt) => { if (!attempt.ok) await logToken({ sessionId: job.sessionId, model: attempt.model, taskType: "fast", promptTokens: 0, completionTokens: 0, latencyMs: attempt.latencyMs, success: false, error: attempt.error, keyIndex: attempt.keyIndex }); },
    });
    await logToken({ sessionId: job.sessionId, model: response.model, taskType: "fast", promptTokens: response.promptTokens, completionTokens: response.completionTokens, latencyMs: response.latencyMs, success: true, keyIndex: response.keyIndex });
    const parsed = extractJsonObject(response.text);
    if (!parsed || !Array.isArray((parsed as { facts?: unknown }).facts)) throw new Error("INVALID_EXTRACTION_JSON");
    const facts = normalizeExtractedFacts(parsed, job.payload.narration, job.payload.playerAction);
    let typesafeAttempted = false;
    const typesafeReport = await runTypeSafePilotSafely({
      facts,
      narration: job.payload.narration,
      playerAction: job.payload.playerAction,
      loadConfig: getTypeSafePilotConfig,
      verify: async (input) => {
        typesafeAttempted = true;
        return verifyTypeSafeFacts(input);
      },
    });
    if (typesafeAttempted) {
      try {
        await logToken({
          sessionId: job.sessionId,
          model: TYPE_SAFE_MODEL,
          taskType: "typesafe-verification",
          promptTokens: typesafeReport.usage?.inputTokens ?? 0,
          completionTokens: typesafeReport.usage?.outputTokens ?? 0,
          latencyMs: typesafeReport.latencyMs,
          success: typesafeReport.status === "ok",
          error: typesafeReport.status === "error" ? "TYPESAFE_UNAVAILABLE" : "",
        });
      } catch { /* shadow-pilot observability must never fail canonical extraction */ }
    }
    const extracted = await db.transaction(async (tx) => {
      await lockSession(tx, job.sessionId);
      const [current] = await tx.select({ id: memoryJobs.id }).from(memoryJobs).where(and(fenced, gt(memoryJobs.leaseExpiresAt, new Date()))).for("update");
      if (!current) return null;
      let changed = 0;
      for (const fact of facts) {
        const result = await upsertMemoryNode({ sessionId: job.sessionId, layer: layerForFactType(fact.type), category: fact.type === "npc" || fact.type === "relationship" ? "npc" : fact.type === "character" ? "character" : fact.type === "event" || fact.type === "promise" ? "event" : "world", title: fact.title, content: fact.content, importance: fact.importance, source: "ai-semantic", sourceTurn: job.turnNumber, entityKey: fact.entityKey || null, mode: fact.entityKey ? "upsert" : "append", confidence: fact.confidence, evidence: fact.evidence }, tx);
        if (result.changed) changed++;
      }
      // Empty extractions are complete too; no partial writes can mark the turn done.
      await tx.update(memoryJobs).set({ status: "completed", factsCount: changed, typesafeReport: typesafeReport.status === "disabled" ? null : typesafeReport, leaseToken: null, leaseExpiresAt: null, error: null, updatedAt: new Date() }).where(fenced);
      return changed;
    });
    return { processed: extracted === null ? 0 : 1, extracted: extracted ?? 0, failed: 0, delayed: false };
  } catch (error) {
    const failed = job.attempts >= 3;
    const rows = await db.update(memoryJobs).set({ status: failed ? "failed" : "pending", leaseToken: null, leaseExpiresAt: null, nextAttemptAt: new Date(Date.now() + retryDelayMs(job.attempts)), error: error instanceof Error && error.message === "INVALID_EXTRACTION_JSON" ? "INVALID_EXTRACTION_JSON" : "PROVIDER_UNAVAILABLE", updatedAt: new Date() }).where(fenced).returning({ id: memoryJobs.id });
    return { processed: 0, extracted: 0, failed: failed ? rows.length : 0, delayed: !failed };
  }
}
