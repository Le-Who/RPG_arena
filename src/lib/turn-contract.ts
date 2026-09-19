import type { AppliedChanges, DiceResult } from "@/db/schema";
import type { TaskType } from "./gemini";
export type TurnResponse = {
  ok: true; turnNumber: number; narration: string; choices: string[]; dice: DiceResult | null;
  outcome: string; applied: AppliedChanges; modelUsed: string; taskType: TaskType; needsCompaction: boolean;
  dead: boolean; retrieved: { id: string; title: string; why: string }[]; skippedModels: string[]; warnings: string[];
  replay?: boolean; requestId?: string;
};
export type TurnErrorCode = "NOT_FOUND" | "AI_REQUIRED" | "AI_FAILED" | "BUSY" | "INVALID_INPUT" | "STALE_TURN" | "IDEMPOTENCY_CONFLICT" | "LEASE_EXPIRED";
export type TurnError = { ok: false; code: TurnErrorCode; message: string; details?: string; retryAfter?: number; currentTurn?: number };
export type TurnInput = { sessionId: string; action: string; isFree: boolean; requestId?: string | null; expectedTurn?: number };
export type TurnStage = "context" | "generation" | "applying" | "completed" | "failed";
export const TURN_STAGE_LABELS: Record<TurnStage, string> = {
  context: "Вспоминаем мир и проверяем действие", generation: "Рассказчик готовит продолжение", applying: "Проверяем и сохраняем последствия", completed: "Ход сохранён", failed: "Ход не применён",
};
export type TurnRequestView = { requestId: string; status: "running" | "completed" | "failed"; stage: TurnStage; baseTurn: number; retryAfter: number; error: string | null; result: TurnResponse | null };
