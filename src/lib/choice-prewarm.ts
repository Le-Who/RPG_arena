import { and, count, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { gameSessions, gameTurns, memoryEmbeddings, memoryNodes } from "@/db/schema";
import { getAIConfig } from "./ai-settings";
import { sessionOwnerId } from "./campaign-access";
import { embedTexts, formatQuery } from "./embeddings";
import { hashContent } from "./memory";
import { buildMemoryQuery, queryVectorCache } from "./query-vectors";

export { buildMemoryQuery } from "./query-vectors";

const PREWARM_TIMEOUT_MS = 5_000;
const MIN_MEMORY_NODES = 7;

/** Best-effort exact query-vector warmup. Safe to invoke from an after() callback. */
export async function prewarmSessionChoices(sessionId: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      runPrewarm(sessionId),
      new Promise<void>(resolve => { timer = setTimeout(resolve, PREWARM_TIMEOUT_MS); }),
    ]);
  } catch {
    // Speculation must never affect loading or playing a turn.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runPrewarm(sessionId: string): Promise<void> {
  const deadline = Date.now() + PREWARM_TIMEOUT_MS;
  const cfg = await getAIConfig(await sessionOwnerId(sessionId));
  if (!cfg.canUseLive || !cfg.embeddingsEnabled || !cfg.keys.length) return;
  const [[session], [last], [nodes], [ready]] = await Promise.all([
    db.select({ worldState: gameSessions.worldState }).from(gameSessions).where(eq(gameSessions.id, sessionId)).limit(1),
    db.select({ content: gameTurns.content, choices: gameTurns.choices }).from(gameTurns).where(and(eq(gameTurns.sessionId, sessionId), eq(gameTurns.role, "narrator"))).orderBy(desc(gameTurns.turnNumber), desc(gameTurns.createdAt)).limit(1),
    db.select({ value: count() }).from(memoryNodes).where(eq(memoryNodes.sessionId, sessionId)),
    db.select({ value: count() }).from(memoryEmbeddings).where(and(eq(memoryEmbeddings.sessionId, sessionId), eq(memoryEmbeddings.status, "ready"), eq(memoryEmbeddings.model, cfg.embeddingModel), eq(memoryEmbeddings.dims, cfg.embeddingDims))),
  ]);
  if (!session || !last || Number(nodes?.value ?? 0) < MIN_MEMORY_NODES || Number(ready?.value ?? 0) < 1) return;
  const location = session.worldState.currentLocation;
  const queries = [...new Set((last.choices ?? []).map(action => buildMemoryQuery(action, location, last.content)))].slice(0, 3);
  const keyed = queries.map(query => ({ query, key: hashContent(sessionId, cfg.embeddingModel, String(cfg.embeddingDims), query) }));
  const remaining = deadline - Date.now();
  if (remaining < 250) return;
  await queryVectorCache.prewarm(keyed.map(item => item.key), async keys => {
    const byKey = new Map(keyed.map(item => [item.key, item.query]));
    const texts = keys.map(key => formatQuery(byKey.get(key)!));
    return (await embedTexts({ keys: cfg.keys, model: cfg.embeddingModel, dims: cfg.embeddingDims, texts, sessionId, timeoutMs: remaining })).vectors;
  });
}
