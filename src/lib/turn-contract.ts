import type { AppliedChanges, DiceResult, CharacterState, WorldState } from "@/db/schema";
import type { TaskType } from "./gemini";
export type TurnResponse = {
  ok: true; turnNumber: number; narration: string; choices: string[]; dice: DiceResult | null;
  outcome: string; applied: AppliedChanges; modelUsed: string; taskType: TaskType; needsCompaction: boolean;
  dead: boolean; retrieved: { id: string; title: string; why: string }[]; skippedModels: string[]; warnings: string[];
  replay?: boolean; requestId?: string;
  playerAction?: string; timings?: TurnTimings;
  state?: { character: CharacterState; worldState: WorldState };
};
export type TurnTimings = { admissionMs?: number; contextMs?: number; retrievalMs?: number; retrievalDatabaseMs?: number; retrievalEmbeddingMs?: number; retrievalCandidates?: number; retrievalBackend?: "postgres" | "legacy"; generationMs?: number; verificationMs?: number; validationMs?: number; writesMs?: number; serverMs?: number; firstTextMs?: number; attempts?: number; thoughtTokens?: number; cachedTokens?: number };
export type TurnErrorCode = "NOT_FOUND" | "AI_REQUIRED" | "AI_FAILED" | "QUOTA_UNAVAILABLE" | "QUOTA_ADMISSION_TIMEOUT" | "QUOTA_ADMISSION_CANCELLED" | "BUSY" | "INVALID_INPUT" | "STALE_TURN" | "IDEMPOTENCY_CONFLICT" | "LEASE_EXPIRED" | "INTERNAL";
export type TurnError = { ok: false; code: TurnErrorCode; message: string; details?: string; retryAfter?: number; currentTurn?: number };
export type TurnInput = { sessionId: string; action: string; isFree: boolean; requestId?: string | null; expectedTurn?: number; itemIds?: string[]; /** Server-authorized owner, never accepted from a JSON body. */ expectedOwnerId?: string };
export type TurnStage = "context" | "generation" | "checking" | "applying" | "completed" | "failed";
export const TURN_STAGE_LABELS: Record<TurnStage, string> = {
  context: "Вспоминаем мир и проверяем действие", generation: "Рассказчик готовит продолжение", checking: "Сверяем рассказ с событиями", applying: "Проверяем и сохраняем последствия", completed: "Ход сохранён", failed: "Ход не применён",
};
export type TurnRequestView = { requestId: string; status: "running" | "completed" | "failed"; stage: TurnStage; baseTurn: number; retryAfter: number; error: string | null; result: TurnResponse | null };
