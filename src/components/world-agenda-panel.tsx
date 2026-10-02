"use client";
import { useState } from "react";
import { BellRing, CalendarDays, Compass, Mic2, Pencil, Save, Users, X } from "lucide-react";
import type { WorldState } from "@/db/schema";
import { api } from "@/lib/api-client";
import { formatClock, readLife } from "@/lib/world-life";
import { AGENDA_KIND_LABELS, agendaAlerts, readAgenda } from "@/lib/world-agenda";
import { NARRATOR_OPTIONS, readNarratorPreferences, summarizeNarrator, type NarratorPreferences } from "@/lib/narrator-preferences";

/** WORLD-2: наступившие и запланированные события, цели персонажей. */
export function WorldAgendaSection({ world }: { world: WorldState }) {
  const agenda = readAgenda(world);
  const alerts = agendaAlerts(agenda, readLife(world).clock);
  const recent = agenda.events.filter((e) => e.status === "fired" || e.status === "cancelled").slice(-5).reverse();
  return <>
    <div className="gx-side-title"><CalendarDays size={13} />События мира</div>
    {alerts.due.map((e) => <div key={e.id} className="lx-commit is-overdue"><div className="lx-commit-head"><strong><BellRing size={12} /> {e.title}</strong><span className="gx-tag">Наступило</span></div><small>{[AGENDA_KIND_LABELS[e.kind], e.npcName, formatClock(e.at)].filter(Boolean).join(" · ")}</small>{e.note && <small>{e.note}</small>}</div>)}
    {alerts.upcoming.map((e) => <div key={e.id} className="lx-commit is-accepted"><div className="lx-commit-head"><strong>{e.title}</strong><span className="gx-tag">Скоро</span></div><small>{[AGENDA_KIND_LABELS[e.kind], e.npcName, formatClock(e.at)].filter(Boolean).join(" · ")}</small>{e.note && <small>{e.note}</small>}</div>)}
    {alerts.later.slice(0, 6).map((e) => <div key={e.id} className="lx-commit is-proposed"><div className="lx-commit-head"><strong>{e.title}</strong><span className="gx-tag">Запланировано</span></div><small>{[AGENDA_KIND_LABELS[e.kind], e.npcName, formatClock(e.at)].filter(Boolean).join(" · ")}</small></div>)}
    {!alerts.due.length && !alerts.upcoming.length && !alerts.later.length && <p className="gx-side-hint">Мир живёт своей жизнью: когда кто-то пообещает прийти, объявят срок или запустится последствие, событие появится здесь и наступит по часам мира — даже если герой занят другим.</p>}
    {!!recent.length && <details className="lx-closed"><summary>Произошло · {recent.length}</summary>{recent.map((e) => <p key={e.id}>{e.title} — {e.status === "fired" ? `ход ${e.firedTurn ?? "?"}` : "отменено"}</p>)}</details>}

    <div className="gx-side-title"><Users size={13} />Цели персонажей</div>
    {agenda.npcAgendas.length ? agenda.npcAgendas.slice(-8).reverse().map((a) => <div key={a.key} className="lx-holding"><div><strong>{a.name}</strong>{a.goal && <small><Compass size={11} /> {a.goal}</small>}{a.routine && <small>{a.routine}</small>}</div></div>)
      : <p className="gx-side-hint">Цели и распорядок персонажей записываются, когда они раскрываются в сцене, — не по догадкам героя.</p>}
  </>;
}

/** NARR-10: голос рассказчика этой истории. */
export function NarratorSection({ sessionId, world, canEdit, disabled, onSaved }: { sessionId: string; world: WorldState; canEdit: boolean; disabled: boolean; onSaved: () => void }) {
  const prefs = readNarratorPreferences(world);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<NarratorPreferences>(prefs);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setSaving(true); setError("");
    try { await api(`/api/sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify({ narrator: draft }) }); setEditing(false); onSaved(); }
    catch (e) { setError(e instanceof Error ? e.message : "Не удалось сохранить"); }
    finally { setSaving(false); }
  };
  const select = <K extends keyof typeof NARRATOR_OPTIONS>(key: K, label: string) => <label>{label}<select value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}>
    {NARRATOR_OPTIONS[key].map((o) => <option key={o.value} value={o.value}>{o.label} — {o.hint}</option>)}
  </select></label>;
  return <>
    <div className="gx-side-title"><Mic2 size={13} />Голос рассказчика</div>
    {!editing ? <div className="lx-shape">
      <div className="lx-shape-head"><strong>{summarizeNarrator(prefs)}</strong>
        {canEdit && <button type="button" className="lx-icon-btn" aria-label="Настроить рассказчика" onClick={() => { setDraft(prefs); setEditing(true); }} disabled={disabled}><Pencil size={13} /></button>}</div>
      <p className="lx-muted">Темп, объём, инициативность мира, реализм и накал. Предпочтения и границы передаются рассказчику; их соблюдение зависит от ответа модели.</p>
      {!!prefs.boundaries.length && <ul className="lx-focus">{prefs.boundaries.map((b) => <li key={b}>Просьба избегать: {b}</li>)}</ul>}
      {prefs.note && <p className="lx-muted">«{prefs.note}»</p>}
    </div> : <form className="lx-shape-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {select("length", "Объём ответа")}
      {select("pace", "Темп")}
      {select("initiative", "Инициатива мира")}
      {select("realism", "Реализм")}
      {select("tension", "Накал")}
      <label>Чего в истории быть не должно — каждый пункт с новой строки<textarea rows={3} value={draft.boundaries.join("\n")} onChange={(e) => setDraft({ ...draft, boundaries: e.target.value.split("\n").slice(0, 6) })} placeholder={"Насилие над животными\nСмерть героя"} /></label>
      <label>Заметка рассказчику<input value={draft.note} maxLength={400} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="стиль, ракурс, акценты" /></label>
      {error && <p className="lx-error" role="alert">{error}</p>}
      <div className="lx-row"><button type="submit" className="button primary" disabled={saving}><Save size={14} />Сохранить</button><button type="button" className="button secondary" onClick={() => setEditing(false)}><X size={14} />Отмена</button></div>
    </form>}
  </>;
}
