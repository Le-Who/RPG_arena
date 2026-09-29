"use client";
import { useState } from "react";
import { CalendarClock, Check, CircleSlash, RotateCcw, X } from "lucide-react";
import { api } from "@/lib/api-client";
import type { Commitment } from "@/lib/world-life";
import { formatMinute } from "@/lib/world-social";
import { OWNER_ACTION_LABELS, commitmentVersion, describeHistoryEntry, type CommitmentAction } from "@/lib/world-commitments";

/** Show the source of accepted outcomes, including explicit owner corrections. */
export function CommitmentHistory({ commitment }: { commitment: Commitment }) {
  const history = (commitment.history ?? []).slice(-3);
  if (!history.length) return null;
  return <div className="cx-history"><ul aria-label="История договорённости">{history.map((entry, index) => <li key={`${entry.turn}-${entry.kind}-${index}`}>{describeHistoryEntry(entry)}</li>)}</ul></div>;
}

/** WORLD-3b: owner marks or corrects the outcome. The server re-checks ownership, lease and version. */
export function CommitmentControls({ sessionId, commitment, currentDay, disabled, onSaved }: { sessionId: string; commitment: Commitment; currentDay: number; disabled: boolean; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [rescheduling, setRescheduling] = useState(false);
  const [day, setDay] = useState(Math.max(commitment.due?.day ?? currentDay, currentDay));
  const [time, setTime] = useState(commitment.due ? formatMinute(commitment.due.minute) : "12:00");
  const send = async (action: CommitmentAction, extra: { day?: number; time?: string } = {}) => {
    setBusy(true); setError("");
    try {
      await api(`/api/sessions/${sessionId}/commitments`, { method: "PATCH", body: JSON.stringify({ id: commitment.id, version: await commitmentVersion(commitment), action, ...extra }) });
      setRescheduling(false);
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : "Не удалось сохранить отметку"); }
    finally { setBusy(false); }
  };
  const locked = disabled || busy;
  const open = commitment.status === "proposed" || commitment.status === "accepted";
  if (!open) return <div className="cx-actions">
    <button type="button" className="cx-button" disabled={locked} onClick={() => void send("reopen")}><RotateCcw size={12} aria-hidden="true" />{OWNER_ACTION_LABELS.reopen}</button>
    {error && <small className="lx-error" role="alert">{error}</small>}
  </div>;
  return <div className="cx-actions" role="group" aria-label={`Исход договорённости «${commitment.title}»`}>
    <button type="button" className="cx-button" disabled={locked} onClick={() => void send("fulfilled")}><Check size={12} aria-hidden="true" />{OWNER_ACTION_LABELS.fulfilled}</button>
    <button type="button" className="cx-button" disabled={locked} onClick={() => void send("missed")}><CircleSlash size={12} aria-hidden="true" />{OWNER_ACTION_LABELS.missed}</button>
    <button type="button" className="cx-button" disabled={locked} aria-expanded={rescheduling} onClick={() => setRescheduling((value) => !value)}><CalendarClock size={12} aria-hidden="true" />{OWNER_ACTION_LABELS.reschedule}</button>
    <button type="button" className="cx-button" disabled={locked} onClick={() => void send("cancelled")}><X size={12} aria-hidden="true" />{OWNER_ACTION_LABELS.cancelled}</button>
    {rescheduling && <form className="cx-reschedule" onSubmit={(event) => { event.preventDefault(); void send("reschedule", { day, time }); }}>
      <label>День<input type="number" min={currentDay} max={100000} step={1} value={day} onChange={(event) => setDay(Number(event.target.value) || currentDay)} required /></label>
      <label>Время<input type="time" value={time} onChange={(event) => setTime(event.target.value)} required /></label>
      <button type="submit" className="cx-button" disabled={locked}>Сохранить срок</button>
    </form>}
    {error && <small className="lx-error" role="alert">{error}</small>}
  </div>;
}
