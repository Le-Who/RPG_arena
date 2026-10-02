import type { WorldState } from "@/db/schema";
import type { MemoryEvent } from "./resolution";
import { COMMITMENT_LABELS, COMMITMENT_HISTORY_LIMIT, MAX_ACTIVE_COMMITMENTS, MAX_COMMITMENT_REVISION, clockValue, formatClock, parseClockTime, readLife, writeLife, type Commitment, type CommitmentHistoryEntry, type WorldClock } from "./world-life";
/** Owner corrections are explicit facts, never inferred attendance. */

export type CommitmentAction = "fulfilled" | "missed" | "cancelled" | "reschedule" | "reopen";
export type CommitmentEdit = { id: string; version: string; action: CommitmentAction; day: number | null; time: string; note: string };
export type CommitmentEditResult =
  | { ok: true; world: WorldState; events: MemoryEvent[]; summary: string; commitment: Commitment }
  | { ok: false; code: "NOT_FOUND" | "STALE_COMMITMENT" | "INVALID_TRANSITION" | "INVALID_TIME"; error: string };

export const OWNER_ACTION_LABELS: Record<CommitmentAction, string> = {
  fulfilled: "Состоялась", missed: "Не состоялась", cancelled: "Отменить", reschedule: "Перенести", reopen: "Вернуть в открытые",
};
export const HISTORY_KIND_LABELS: Record<CommitmentHistoryEntry["kind"], string> = {
  rescheduled: "перенесено", missed: "неявка", fulfilled: "состоялось", broken: "нарушено", cancelled: "отменено",
  reopened: "возвращено в открытые",
};
const ACTIONS = Object.keys(OWNER_ACTION_LABELS) as CommitmentAction[];

/** Browser/server content token includes bounded history and all agreement terms. */
export async function commitmentVersion(commitment: Commitment): Promise<string> {
  const canonical = JSON.stringify([
    commitment.id, commitment.title, commitment.parties, commitment.place, commitment.status,
    commitment.createdTurn, commitment.updatedTurn, commitment.note, commitment.revision ?? 0,
    commitment.due ? [commitment.due.day, commitment.due.minute] : null,
    commitment.missEffect ?? null, commitment.attendance ?? null,
    (commitment.history ?? []).map(entry => [entry.turn, entry.kind,
      entry.from ? [entry.from.day, entry.from.minute] : null,
      entry.to ? [entry.to.day, entry.to.minute] : null, entry.source ?? null, entry.note ?? null]),
  ]);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function parseCommitmentEdit(raw: unknown): CommitmentEdit | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" && !!value.id.trim() && value.id.length <= 64 ? value.id : null;
  const version = typeof value.version === "string" && /^[a-f0-9]{64}$/.test(value.version) ? value.version : null;
  const action = ACTIONS.includes(value.action as CommitmentAction) ? value.action as CommitmentAction : null;
  if (!id || !version || !action) return null;
  const note = typeof value.note === "string" ? value.note.trim().slice(0, 200) : "";
  if (action !== "reschedule") return { id, version, action, day: null, time: "", note };
  const day = typeof value.day === "number" && Number.isSafeInteger(value.day) && value.day >= 1 && value.day <= 100_000 ? value.day : null;
  const time = typeof value.time === "string" && parseClockTime(value.time.trim()) !== null ? value.time.trim() : "";
  if (day === null || !time) return null;
  return { id, version, action, day, time, note };
}

export async function resolveCommitment(input: { world: WorldState; edit: CommitmentEdit; turn: number }): Promise<CommitmentEditResult> {
  const life = readLife(input.world);
  const index = life.commitments.findIndex((commitment) => commitment.id === input.edit.id);
  if (index < 0) return { ok: false, code: "NOT_FOUND", error: "Договорённость не найдена" };
  const current = life.commitments[index];
  if (await commitmentVersion(current) !== input.edit.version) return { ok: false, code: "STALE_COMMITMENT", error: "Договорённость уже изменилась — обновите панель и повторите" };
  const revision = current.revision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= MAX_COMMITMENT_REVISION) return { ok: false, code: "INVALID_TRANSITION", error: "Договорённость достигла предела исправлений" };
  const open = current.status === "proposed" || current.status === "accepted";
  const { action, note } = input.edit;
  if (action === "reopen" ? open : !open) return { ok: false, code: "INVALID_TRANSITION", error: action === "reopen" ? "Договорённость ещё открыта" : "Договорённость уже закрыта — сначала верните её в открытые" };
  const entry = (kind: CommitmentHistoryEntry["kind"], from: WorldClock | null, to: WorldClock | null): CommitmentHistoryEntry => ({ turn: input.turn, kind, from, to, source: "owner", ...(note ? { note } : {}) });
  const history = (added: CommitmentHistoryEntry) => [...(current.history ?? []), added].slice(-COMMITMENT_HISTORY_LIMIT);
  let next: Commitment;
  if (action === "reschedule") {
    const minute = parseClockTime(input.edit.time);
    if (minute === null || input.edit.day === null || !Number.isSafeInteger(input.edit.day) || input.edit.day < 1 || input.edit.day > 100_000) return { ok: false, code: "INVALID_TIME", error: "Укажите день и время в формате ЧЧ:ММ" };
    const due = { day: input.edit.day, minute };
    if (clockValue(due) < clockValue(life.clock)) return { ok: false, code: "INVALID_TIME", error: "Новый срок не может быть в прошлом мира" };
    next = { ...current, due, updatedTurn: input.turn, history: history(entry("rescheduled", current.due ? { ...current.due } : null, { ...due })) };
    delete next.attendance;
  } else if (action === "reopen") {
    if (life.commitments.filter(c => c.status === "proposed" || c.status === "accepted").length >= MAX_ACTIVE_COMMITMENTS) return { ok: false, code: "INVALID_TRANSITION", error: "Слишком много открытых договорённостей" };
    next = { ...current, status: "accepted", updatedTurn: input.turn, history: history(entry("reopened", null, null)) };
    delete next.attendance;
  } else {
    const status = action === "fulfilled" ? "fulfilled" : action === "cancelled" ? "cancelled" : "broken";
    next = { ...current, status, updatedTurn: input.turn, history: history(entry(action, current.due ? { ...current.due } : null, { ...life.clock })) };
  }
  next.revision = revision + 1;
  const world = writeLife(input.world, { ...life, commitments: life.commitments.map((commitment, i) => (i === index ? next : commitment)) });
  const outcome = action === "missed" ? "не состоялась — неявка; отношения автоматически не менялись"
    : action === "reschedule" ? `перенесена на ${formatClock(next.due!)}`
    : action === "reopen" ? "снова открыта после исправления"
    : COMMITMENT_LABELS[next.status].toLowerCase();
  const events: MemoryEvent[] = [{
    layer: "semantic", category: "quest", title: `Договорённость: ${next.title}`,
    content: `${COMMITMENT_LABELS[next.status]}${next.parties.length ? ` — ${next.parties.join(", ")}` : ""}${next.place ? `, место: ${next.place}` : ""}${next.due ? `, срок: ${formatClock(next.due)}` : ""}. Отметка владельца (ход ${input.turn}): ${outcome}${note ? `. Примечание: ${note}` : ""}.`,
    importance: next.status === "accepted" ? 70 : 55, entityKey: `commitment:${next.id}`, mode: "upsert",
  }];
  return { ok: true, world, events, summary: `«${next.title}»: ${outcome}`, commitment: next };
}

export function describeHistoryEntry(entry: CommitmentHistoryEntry): string {
  const source = entry.source === "owner" ? "отметка владельца" : "рассказ";
  const move = entry.kind === "rescheduled" && entry.from && entry.to ? ` ${formatClock(entry.from)} → ${formatClock(entry.to)}` : "";
  return `Ход ${entry.turn}: ${HISTORY_KIND_LABELS[entry.kind] ?? entry.kind}${move} · ${source}${entry.note ? ` — ${entry.note}` : ""}`;
}
