"use client";
import { useState } from "react";
import { CalendarClock, Clock3, Handshake, Hourglass, PackageOpen, Pencil, RotateCcw, Save, Target, X } from "lucide-react";
import type { WorldState } from "@/db/schema";
import { api } from "@/lib/api-client";
import { COMMITMENT_LABELS, STORY_SHAPE_LABELS, commitmentAlerts, formatClock, readLife, type StoryShape, type StoryShapeKind } from "@/lib/world-life";
import { WAIT_OPTIONS, formatMinutes, interactionText, type InteractionState } from "@/lib/interactions";
import { EntityActions } from "./entity-actions";

/** INTERACT-2 / NARR-7: время мира, форма истории, договорённости и вещи, которые сейчас не у героя. */
export function LifePanel({ sessionId, world, canEdit, disabled, interactionState, onPick, onSaved }: {
  sessionId: string; world: WorldState; canEdit: boolean; disabled: boolean; interactionState: InteractionState;
  onPick: (text: string, itemIds: string[]) => void; onSaved: () => void;
}) {
  const life = readLife(world);
  const alerts = commitmentAlerts(life);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<StoryShape>(life.story);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const open = life.commitments.filter((c) => c.status === "proposed" || c.status === "accepted");
  const closed = life.commitments.filter((c) => !(c.status === "proposed" || c.status === "accepted")).slice(-5).reverse();
  const save = async (patch: Record<string, unknown>) => {
    setSaving(true); setError("");
    try { await api(`/api/sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify({ storyShape: patch }) }); setEditing(false); onSaved(); }
    catch (e) { setError(e instanceof Error ? e.message : "Не удалось сохранить"); }
    finally { setSaving(false); }
  };
  const shape = life.story;
  return <div className="gx-side-section lx-life">
    <div className="lx-clock"><Clock3 size={20} aria-hidden="true" /><div><small>Время мира</small><strong>{formatClock(life.clock)}</strong></div></div>
    <div className="lx-wait" role="group" aria-label="Подождать">
      <Hourglass size={13} aria-hidden="true" />
      {WAIT_OPTIONS.map((minutes) => <button key={minutes} type="button" disabled={disabled} onClick={() => onPick(interactionText({ verb: "wait", target: { kind: "none", ref: "", name: "" }, minutes }), [])}>{formatMinutes(minutes)}</button>)}
    </div>

    <div className="gx-side-title"><Target size={13} />Форма истории</div>
    {!editing ? <div className={`lx-shape is-${shape.kind} ${shape.status === "resolved" ? "is-resolved" : ""}`}>
      <div className="lx-shape-head"><strong>{STORY_SHAPE_LABELS[shape.kind].title}</strong>{shape.status === "resolved" && <span className="gx-tag">Завершена</span>}
        {canEdit && <button type="button" className="lx-icon-btn" aria-label="Изменить форму истории" onClick={() => { setDraft(life.story); setEditing(true); }} disabled={disabled}><Pencil size={13} /></button>}</div>
      <p className="lx-muted">{STORY_SHAPE_LABELS[shape.kind].description}</p>
      {shape.kind === "arc" && <dl className="lx-dl">
        {shape.goal && <><dt>Цель</dt><dd>{shape.goal}</dd></>}
        {shape.stakes && <><dt>Ставки</dt><dd>{shape.stakes}</dd></>}
        {shape.conflict && <><dt>Конфликт</dt><dd>{shape.conflict}</dd></>}
        {shape.endCondition && <><dt>Финал, когда</dt><dd>{shape.endCondition}</dd></>}
      </dl>}
      {shape.kind !== "arc" && !!shape.focus.length && <ul className="lx-focus">{shape.focus.map((f) => <li key={f}>{f}</li>)}</ul>}
      {shape.status === "resolved" && <>
        {shape.epilogue && <p className="lx-epilogue">{shape.epilogue}</p>}
        {canEdit && <button type="button" className="button secondary full-width" disabled={saving || disabled} onClick={() => void save({ reopen: true })}><RotateCcw size={14} />Продолжить после финала</button>}
      </>}
    </div> : <form className="lx-shape-form" onSubmit={(e) => { e.preventDefault(); void save(draft); }}>
      <label>Тип<select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as StoryShapeKind })}>
        {(Object.keys(STORY_SHAPE_LABELS) as StoryShapeKind[]).map((kind) => <option key={kind} value={kind}>{STORY_SHAPE_LABELS[kind].title}</option>)}
      </select></label>
      {draft.kind === "arc" ? <>
        <label>Цель<input value={draft.goal} maxLength={240} onChange={(e) => setDraft({ ...draft, goal: e.target.value })} /></label>
        <label>Ставки<input value={draft.stakes} maxLength={240} onChange={(e) => setDraft({ ...draft, stakes: e.target.value })} placeholder="Что будет потеряно при неудаче" /></label>
        <label>Конфликт<input value={draft.conflict} maxLength={240} onChange={(e) => setDraft({ ...draft, conflict: e.target.value })} /></label>
        <label>Условие завершения<input value={draft.endCondition} maxLength={240} onChange={(e) => setDraft({ ...draft, endCondition: e.target.value })} placeholder="Когда арка считается законченной" /></label>
      </> : <label>Текущие дела и намерения (по строке)<textarea rows={3} value={draft.focus.join("\n")} onChange={(e) => setDraft({ ...draft, focus: e.target.value.split("\n").slice(0, 6) })} /></label>}
      {error && <p className="lx-error" role="alert">{error}</p>}
      <div className="lx-row"><button type="submit" className="button primary" disabled={saving}><Save size={14} />Сохранить</button><button type="button" className="button secondary" onClick={() => setEditing(false)}><X size={14} />Отмена</button></div>
    </form>}

    <div className="gx-side-title"><Handshake size={13} />Договорённости и планы</div>
    {open.length ? open.map((c) => {
      const overdue = alerts.overdue.some((a) => a.id === c.id), soon = alerts.due.some((a) => a.id === c.id);
      return <div key={c.id} className={`lx-commit is-${c.status} ${overdue ? "is-overdue" : ""}`}>
        <div className="lx-commit-head"><strong>{c.title}</strong><span className="gx-tag">{COMMITMENT_LABELS[c.status]}</span></div>
        <small>{[c.parties.join(", "), c.place, c.due ? formatClock(c.due) : ""].filter(Boolean).join(" · ") || "Без срока"}</small>
        {(overdue || soon) && <small className="lx-alert"><CalendarClock size={12} />{overdue ? "Срок прошёл — мир может отреагировать" : "Скоро срок"}</small>}
      </div>;
    }) : <p className="gx-side-hint">Встречи, обещания и сделки появятся, когда вы договоритесь с кем-то в истории. Предложение не равно согласию: статус меняется только после ответа другой стороны.</p>}
    {!!closed.length && <details className="lx-closed"><summary>Закрытые · {closed.length}</summary>{closed.map((c) => <p key={c.id}>{c.title} — {COMMITMENT_LABELS[c.status].toLowerCase()}</p>)}</details>}

    <div className="gx-side-title"><PackageOpen size={13} />Вещи не у героя</div>
    {life.holdings.length ? life.holdings.slice(-12).reverse().map((h) => <div key={h.id} className="lx-holding">
      <div><strong>{h.name}{h.quantity > 1 ? ` ×${h.quantity}` : ""}</strong><small>{h.holderKind === "npc" ? `У ${h.holderName}` : `Лежит: ${h.holderName}`} · с хода {h.turn}</small></div>
      {h.holderKind === "location" && <EntityActions kind="holding" refId={`${h.holderKey}:${h.name}`} name={h.name} state={interactionState} disabled={disabled} onPick={onPick} />}
    </div>) : <p className="gx-side-hint">Переданные и оставленные вещи сохраняют владельца и место — их можно будет вернуть по сюжету.</p>}
  </div>;
}
