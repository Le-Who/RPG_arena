import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gt, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { gameSessions, gameTurns, turnRequests, type DiceResult } from "@/db/schema";
import { serverCheck } from "./engine";
import { HttpError, expectedTurn, requestKey, requiredText, requireUuid } from "./http";
import { normalizeItemIds } from "./item-bindings";
import type { TurnInput, TurnRequestView, TurnResponse, TurnStage } from "./turn-contract";
export const TURN_LEASE_MS = 90_000;
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type TurnLease = { id: string; token: string; requestId: string; sessionId: string; baseTurn: number; dice: DiceResult | null; session: typeof gameSessions.$inferSelect };
export function turnInputHash(input: Pick<TurnInput, "action" | "isFree" | "expectedTurn" | "itemIds">): string {
  const itemIds = normalizeItemIds(input.itemIds);
  return createHash("sha256").update(JSON.stringify({ action: input.action.trim(), isFree: input.isFree, expectedTurn: input.expectedTurn ?? null, ...(itemIds.length ? { itemIds } : {}) })).digest("hex");
}
export function normalizeTurnInput(input: TurnInput): TurnInput & { requestId: string } {
  requireUuid(input.sessionId);
  if (typeof input.isFree !== "boolean") throw new HttpError(400, "INVALID_INPUT", "Тип действия должен быть указан явно.");
  return { ...input, action: requiredText(input.action, "Действие", 2000), expectedTurn: expectedTurn(input.expectedTurn), requestId: requestKey(input.requestId) ?? randomUUID(), itemIds: normalizeItemIds(input.itemIds) };
}
export async function lockSession(tx: DbTransaction, id: string) { await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`); }
export async function assertNoRunningTurn(tx: DbTransaction, id: string) {
  const [active] = await tx.select({ expires: turnRequests.leaseExpiresAt }).from(turnRequests).where(and(eq(turnRequests.sessionId, id), eq(turnRequests.status, "running"), gt(turnRequests.leaseExpiresAt, new Date()))).limit(1);
  if (active) throw new HttpError(429, "BUSY", "Сначала дождитесь завершения текущего хода.", { retryAfter: 2 });
}
export async function acquireTurn(input: TurnInput & { requestId: string }): Promise<{ kind: "lease"; lease: TurnLease } | { kind: "replay"; result: TurnResponse }> {
  const inputHash = turnInputHash(input);
  return db.transaction(async (tx) => {
    await lockSession(tx, input.sessionId);
    const [session] = await tx.select().from(gameSessions).where(eq(gameSessions.id, input.sessionId));
    if (!session) throw new HttpError(404, "NOT_FOUND", "Кампания не найдена.");
    const [previous] = await tx.select().from(turnRequests).where(and(eq(turnRequests.sessionId, input.sessionId), eq(turnRequests.requestId, input.requestId)));
    if (previous && previous.inputHash !== inputHash) throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "Этот requestId уже относится к другому действию. История не изменена.");
    if (previous?.status === "completed" && previous.result) return { kind: "replay", result: { ...previous.result, replay: true } };
    // Compatibility with committed v2.1 turns. Never replay a different payload.
    if (!previous) {
      const [legacy] = await tx.select().from(gameTurns).where(and(eq(gameTurns.sessionId, input.sessionId), eq(gameTurns.requestId, input.requestId), eq(gameTurns.role, "player"))).limit(1);
      if (legacy) {
        if (input.itemIds?.length || legacy.content !== input.action || (legacy.taskType === "resolution") !== input.isFree || (input.expectedTurn !== undefined && input.expectedTurn !== legacy.turnNumber - 1)) throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "Этот requestId уже использован другим действием.");
        const [n] = await tx.select().from(gameTurns).where(and(eq(gameTurns.sessionId, input.sessionId), eq(gameTurns.turnNumber, legacy.turnNumber), eq(gameTurns.role, "narrator"))).limit(1);
        if (n?.stateChanges) return { kind: "replay", result: { ok: true, replay: true, requestId: input.requestId, turnNumber: n.turnNumber, narration: n.content, choices: n.choices ?? [], dice: n.dice, outcome: "replay", applied: n.stateChanges, modelUsed: n.modelUsed ?? "", taskType: n.taskType === "resolution" ? "resolution" : "narration", needsCompaction: false, dead: n.stateChanges.dead, retrieved: [], skippedModels: [], warnings: ["Повтор хода, сохранённого до v2.2"] } };
      }
    }
    if (session.status !== "active") throw new HttpError(429, "BUSY", "Кампания находится в архиве. Сначала восстановите её.");
    if (input.expectedTurn !== undefined && input.expectedTurn !== session.turnCount) throw new HttpError(409, "STALE_TURN", "В другой вкладке уже появился новый ход. Обновите сцену и выберите действие заново.", { currentTurn: session.turnCount });
    if (previous && previous.baseTurn !== session.turnCount) throw new HttpError(409, "STALE_TURN", "История изменилась после неудачной попытки. Выберите новое действие.", { currentTurn: session.turnCount });
    await assertNoRunningTurn(tx, input.sessionId);
    await tx.update(turnRequests).set({ status: "failed", stage: "failed", leaseToken: null, leaseExpiresAt: null, error: "LEASE_EXPIRED", updatedAt: new Date() }).where(and(eq(turnRequests.sessionId, input.sessionId), eq(turnRequests.status, "running"), lte(turnRequests.leaseExpiresAt, new Date())));
    if (!input.isFree) {
      const [last] = await tx.select({ choices: gameTurns.choices }).from(gameTurns).where(and(eq(gameTurns.sessionId, input.sessionId), eq(gameTurns.role, "narrator"))).orderBy(desc(gameTurns.turnNumber)).limit(1);
      if (!last?.choices?.some(choice => choice.trim() === input.action)) throw new HttpError(409, "INVALID_INPUT", "Такого варианта нет в текущей сцене. Обновите её или отправьте свободное действие.");
    }
    // Input mode selects the narration route, not whether campaign mechanics apply.
    const dice = previous ? previous.dice : serverCheck({ rulesProfile: session.rulesProfile, playerAction: input.action, stats: session.character.stats, danger: session.worldState.danger, turnCount: session.turnCount + 1 });
    const token = randomUUID();
    const values = { status: "running" as const, stage: "context" as const, leaseToken: token, leaseExpiresAt: new Date(Date.now() + TURN_LEASE_MS), error: null, dice, updatedAt: new Date() };
    const [row] = previous
      ? await tx.update(turnRequests).set({ ...values, attempts: previous.attempts + 1 }).where(eq(turnRequests.id, previous.id)).returning()
      : await tx.insert(turnRequests).values({ ...values, sessionId: input.sessionId, requestId: input.requestId, inputHash, action: input.action, isFree: input.isFree, baseTurn: session.turnCount }).returning();
    return { kind: "lease", lease: { id: row.id, token, requestId: input.requestId, sessionId: session.id, baseTurn: session.turnCount, dice: dice ?? null, session } };
  });
}
function leaseCondition(lease: TurnLease) { return and(eq(turnRequests.id, lease.id), eq(turnRequests.sessionId, lease.sessionId), eq(turnRequests.leaseToken, lease.token), eq(turnRequests.status, "running"), gt(turnRequests.leaseExpiresAt, new Date())); }
export async function setTurnStage(lease: TurnLease, stage: TurnStage) {
  const rows = await db.update(turnRequests).set({ stage, updatedAt: new Date() }).where(leaseCondition(lease)).returning({ id: turnRequests.id });
  if (!rows.length) throw new HttpError(409, "LEASE_EXPIRED", "Время обработки истекло. Поздний ответ не изменит мир — повторите действие.");
}
export async function assertTurnLease(tx: DbTransaction, lease: TurnLease) {
  const [row] = await tx.select({ id: turnRequests.id }).from(turnRequests).where(leaseCondition(lease));
  if (!row) throw new HttpError(409, "LEASE_EXPIRED", "Право обработки хода истекло. История не изменена.");
}
export async function completeTurnRequest(tx: DbTransaction, lease: TurnLease, result: TurnResponse) {
  const rows = await tx.update(turnRequests).set({ status: "completed", stage: "completed", result: { ...result, requestId: lease.requestId }, leaseToken: null, leaseExpiresAt: null, error: null, updatedAt: new Date() }).where(leaseCondition(lease)).returning({ id: turnRequests.id });
  if (!rows.length) throw new HttpError(409, "LEASE_EXPIRED", "Ответ пришёл слишком поздно; изменения отменены.");
}
export async function failTurnRequest(lease: TurnLease, code: string) {
  await db.update(turnRequests).set({ status: "failed", stage: "failed", error: code.slice(0, 80), leaseToken: null, leaseExpiresAt: null, updatedAt: new Date() }).where(and(eq(turnRequests.id, lease.id), eq(turnRequests.leaseToken, lease.token), eq(turnRequests.status, "running")));
}
export async function getTurnRequest(sessionId: string, requestId: string): Promise<TurnRequestView | null> {
  const [r] = await db.select().from(turnRequests).where(and(eq(turnRequests.sessionId, sessionId), eq(turnRequests.requestId, requestId))).limit(1);
  if (!r) return null;
  const expired = r.status === "running" && (!r.leaseExpiresAt || r.leaseExpiresAt.getTime() <= Date.now());
  return { requestId: r.requestId, status: expired ? "failed" : r.status, stage: expired ? "failed" : r.stage, baseTurn: r.baseTurn, retryAfter: r.status === "running" && !expired ? 2 : 0, error: expired ? "LEASE_EXPIRED" : r.error, result: r.status === "completed" ? r.result : null };
}
