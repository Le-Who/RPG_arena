import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, lt } from "drizzle-orm";
import type { db } from "../db";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { agreementEvents } from "../db/schema";

export type AgreementStatus = "proposed" | "accepted" | "fulfilled" | "cancelled";
export type AgreementProposal = {
  agreementId?: string; previousRevisionId?: string;
  parties: string[]; object: string; consideration: string; conditions: string[]; status: AgreementStatus;
  source?: { kind: "player_intent" | "current_turn"; quote?: string; start?: number; end?: number };
};
export type AgreementRevision = {
  id: string; agreementId: string; sessionId: string; turnNumber: number; version: number;
  previousRevisionId: string | null; parties: string[]; object: string; consideration: string;
  conditions: string[]; status: AgreementStatus; rulesVersion: 1;
  source: { kind: "player_intent" | "current_turn"; originTurnId: string; turnNumber: number; quote: string; start: number; end: number; textSha256: string };
};
export type AgreementRejection = { index: number; reason: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bounded = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Invalid proposals remain visible to the final narrative guard. Never truncate an oversized batch into accepted contracts. */
export function parseAgreementProposals(value: unknown): { proposals: AgreementProposal[]; rejected: AgreementRejection[] } {
  if (value === undefined) return { proposals: [], rejected: [] };
  if (!Array.isArray(value)) return { proposals: [], rejected: [{ index: -1, reason: "INVALID_AGREEMENT_ARRAY" }] };
  const proposals: AgreementProposal[] = [], rejected: AgreementRejection[] = [];
  value.forEach((v, index) => {
    let reason = "";
    if (index >= 3) reason = "AGREEMENT_LIMIT";
    else if (!record(v) || !Array.isArray(v.parties) || v.parties.length < 2 || v.parties.length > 6 || !v.parties.every(p => bounded(p, 160))
      || new Set(v.parties).size !== v.parties.length || !bounded(v.object, 600) || !bounded(v.consideration, 800)
      || !Array.isArray(v.conditions) || v.conditions.length > 6 || !v.conditions.every(c => bounded(c, 400))
      || !["proposed", "accepted", "fulfilled", "cancelled"].includes(String(v.status))) reason = "INVALID_AGREEMENT_TERMS";
    else if ((v.agreementId !== undefined && (typeof v.agreementId !== "string" || !uuid.test(v.agreementId)))
      || (v.previousRevisionId !== undefined && (typeof v.previousRevisionId !== "string" || !uuid.test(v.previousRevisionId)))
      || (!!v.agreementId !== !!v.previousRevisionId)) reason = "INVALID_AGREEMENT_REFERENCE";
    else if (v.source !== undefined && (!record(v.source) || !["player_intent", "current_turn"].includes(String(v.source.kind))
      || (v.source.quote !== undefined && (!bounded(v.source.quote, 4000) || !Number.isSafeInteger(v.source.start) || !Number.isSafeInteger(v.source.end))))) reason = "INVALID_AGREEMENT_SOURCE";
    if (reason) rejected.push({ index, reason });
    else {
      const p = v as AgreementProposal;
      proposals.push({ parties: [...p.parties], object: p.object, consideration: p.consideration, conditions: [...p.conditions], status: p.status,
        ...(p.agreementId ? { agreementId: p.agreementId.toLowerCase(), previousRevisionId: p.previousRevisionId!.toLowerCase() } : {}),
        ...(p.source ? { source: { ...p.source } } : {}) });
    }
  });
  return { proposals, rejected };
}

/** Structural admission only: the independent narrative guard must verify the frozen terms before any append. */
export function reduceAgreementProposals(input: {
  sessionId: string; turnNumber: number; originTurnId?: string; currentNarration: string; playerAction: string;
  history: AgreementRevision[]; proposals: AgreementProposal[];
}, makeId: () => string = randomUUID): { accepted: AgreementRevision[]; rejected: AgreementRejection[] } {
  if (!uuid.test(input.sessionId) || !Number.isSafeInteger(input.turnNumber) || input.turnNumber < 1) throw new Error("INVALID_AGREEMENT_CONTEXT");
  const parsed = parseAgreementProposals(input.proposals), rejected = [...parsed.rejected], accepted: AgreementRevision[] = [];
  const seen = new Set<string>();
  parsed.proposals.forEach((p, index) => {
    const prior = input.history.filter(h => h.sessionId === input.sessionId && h.agreementId === p.agreementId).sort((a, b) => b.version - a.version)[0];
    let reason = "";
    if (p.agreementId && (!prior || prior.turnNumber >= input.turnNumber)) reason = "UNKNOWN_OR_FOREIGN_AGREEMENT";
    else if (p.agreementId && (prior.id !== p.previousRevisionId || seen.has(p.agreementId))) reason = "STALE_AGREEMENT_REVISION";
    else if (prior && ["fulfilled", "cancelled"].includes(prior.status)) reason = "TERMINAL_AGREEMENT";
    else if (!prior && !["proposed", "accepted"].includes(p.status)) reason = "MISSING_AGREEMENT_HISTORY";
    else if (prior?.status === "proposed" && p.status === "fulfilled") reason = "AGREEMENT_NOT_ACCEPTED";
    else if (prior?.status === "accepted" && p.status === "proposed") reason = "AGREEMENT_STATUS_REGRESSION";
    else if (p.source?.kind === "player_intent" && (p.status !== "proposed" || !!prior)) reason = "PLAYER_INTENT_IS_NOT_ACCEPTANCE";
    if (p.source?.quote !== undefined) {
      const sourceText = p.source.kind === "player_intent" ? input.playerAction : input.currentNarration;
      if (p.source.start! < 0 || p.source.end! <= p.source.start! || sourceText.slice(p.source.start, p.source.end) !== p.source.quote) reason = "AGREEMENT_SOURCE_MISMATCH";
    }
    if (reason) { rejected.push({ index, reason }); return; }
    const agreementId = p.agreementId ?? makeId();
    seen.add(agreementId);
    accepted.push({ id: makeId(), agreementId, sessionId: input.sessionId, turnNumber: input.turnNumber,
      version: (prior?.version ?? 0) + 1, previousRevisionId: prior?.id ?? null,
      parties: [...p.parties], object: p.object, consideration: p.consideration, conditions: [...p.conditions], status: p.status, rulesVersion: 1,
      // Intentionally unbound until verified final prose and its persisted narrator ID exist.
      source: { kind: p.source?.kind ?? "current_turn", originTurnId: input.originTurnId ?? "", turnNumber: input.turnNumber, quote: "", start: 0, end: 0, textSha256: "" } });
  });
  return { accepted, rejected };
}

export async function loadAgreementHistory(reader: Pick<typeof db, "select">, sessionId: string, beforeTurn: number): Promise<AgreementRevision[]> {
  if (!uuid.test(sessionId) || !Number.isSafeInteger(beforeTurn) || beforeTurn < 1) throw new Error("INVALID_AGREEMENT_CONTEXT");
  const rows = await reader.select().from(agreementEvents).where(and(eq(agreementEvents.sessionId, sessionId), lt(agreementEvents.turnNumber, beforeTurn)))
    .orderBy(asc(agreementEvents.turnNumber), asc(agreementEvents.version)).limit(1001);
  if (rows.length > 1000) throw new Error("AGREEMENT_HISTORY_LIMIT");
  return rows.map(({ createdAt: _createdAt, ...revision }) => revision);
}

/** Caller passes its existing atomic turn transaction; this helper never opens a connection or transaction. */
export async function appendAgreementRevisions<Q extends PgQueryResultHKT>(tx: Pick<PgDatabase<Q>, "insert">, revisions: AgreementRevision[], finalSource: { narration: string; narratorTurnId: string }): Promise<AgreementRevision[]> {
  if (!revisions.length) return [];
  if (!uuid.test(finalSource.narratorTurnId) || !finalSource.narration.trim()) throw new Error("INVALID_AGREEMENT_FINAL_SOURCE");
  const bound = revisions.map(r => ({ ...r, source: { ...r.source, originTurnId: finalSource.narratorTurnId,
    quote: finalSource.narration, start: 0, end: finalSource.narration.length,
    textSha256: createHash("sha256").update(finalSource.narration).digest("hex") } }));
  await tx.insert(agreementEvents).values(bound);
  return bound;
}
