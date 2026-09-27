"use client";
import { useState } from "react";
import { CalendarClock, Link2, MapPin, Plus, Trash2, Pencil } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { readLife } from "@/lib/world-life";
import type { WorldState } from "@/db/schema";
import { BOND_KIND_LABELS, formatMinute, formatWindow, npcPresence, readSocial, scheduleVersion } from "@/lib/world-social";

type NpcLite = { key: string; name: string; status: string };

/** WORLD-2b (2.9): кто сейчас рядом по распорядку — детерминированный расчёт от часов мира, без вызова модели. */
export function PresenceStrip({ world, npcs }: { world: WorldState; npcs: NpcLite[] }) {
  const presence = npcPresence(world, npcs);
  if (!presence.here.length && !presence.away.length && !presence.later.length) return null;
  return <section className="sx-presence" aria-label="Люди по распорядку">
    <div className="gx-side-title"><CalendarClock size={13} />Люди по распорядку</div>
    {presence.here.length > 0 && <p className="sx-here"><MapPin size={12} aria-hidden="true" /> Здесь сейчас: {presence.here.map((e) => `${e.name} (${e.hint})`).join(", ")}</p>}
    {presence.away.length > 0 && <p className="sx-away">В других местах: {presence.away.map((e) => `${e.name} — «${e.place}», ${e.hint}`).join("; ")}</p>}
    {presence.later.length > 0 && <p className="sx-later">Позже: {presence.later.slice(0, 5).map((e) => `${e.name} — «${e.place}», ${e.hint}`).join("; ")}</p>}
    <small className="sx-note">Считается по часам мира и распорядку из сцен и уточнений владельца. Рассказ может показать причину отклонения.</small>
  </section>;
}

/** WORLD-2 (2.9) + WORLD-10: история связи, знания и распорядок NPC; владелец может уточнять и снимать записи. */
export function NpcBondDetails({ world, npcKey, sessionId, canEdit = false, disabled = false, onSaved }: {
  world: WorldState; npcKey: string; sessionId?: string; canEdit?: boolean; disabled?: boolean; onSaved?: () => void;
}) {
  const social = readSocial(world);
  const bond = social.bonds.find((b) => b.key === npcKey);
  const slots = social.schedules.filter((s) => s.npcKey === npcKey);
  const editable = canEdit && !!sessionId;
  const [mode, setMode] = useState<"none" | "slot" | "know">("none");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slotForm, setSlotForm] = useState({ place: "", from: "09:00", to: "18:00", repeat: "daily" as "daily" | "once", day: String(readLife(world).clock.day), note: "" });
  const [editingSlot, setEditingSlot] = useState<{ id: string; expected: string } | null>(null);
  const [knowText, setKnowText] = useState("");
  if (!bond?.history.length && !bond?.knows.length && !slots.length && !editable) return null;
  const send = async (edit: Record<string, unknown>) => {
    if (!sessionId || disabled || pending) return;
    setPending(true); setError(null);
    try { await api(`/api/sessions/${sessionId}/social`, { method: "PATCH", body: JSON.stringify(edit) }); setMode("none"); setEditingSlot(null); setKnowText(""); onSaved?.(); }
    catch (e) { if (e instanceof ApiError && e.status === 409) { setMode("none"); setEditingSlot(null); onSaved?.(); } setError(e instanceof Error ? e.message : "Не удалось сохранить правку"); }
    finally { setPending(false); }
  };
  const busy = disabled || pending;
  return <details className="sx-bond">
    <summary>Связь и распорядок</summary>
    {slots.length > 0 && <ul className="sx-slots">{slots.map((s) => <li key={s.id}><CalendarClock size={11} aria-hidden="true" /> «{s.place}», {formatWindow(s)}{s.note ? ` — ${s.note}` : ""}{s.source === "owner" && <span className="sx-owner" title="Уточнено владельцем кампании"> · владелец</span>}
      {editable && <button type="button" className="sx-remove" aria-label={`Изменить окно «${s.place}», ${formatWindow(s)}`} disabled={busy} onClick={() => { setEditingSlot({ id: s.id, expected: scheduleVersion(s) }); setSlotForm({ place: s.place, from: formatMinute(s.from), to: formatMinute(s.to), repeat: s.repeat, day: String(s.day ?? readLife(world).clock.day), note: s.note }); setMode("slot"); }}><Pencil size={11} aria-hidden="true" /></button>}
      {editable && <button type="button" className="sx-remove" aria-label={`Убрать окно «${s.place}», ${formatWindow(s)}`} title="Убрать окно распорядка" disabled={busy} onClick={() => { void send({ op: "schedule.remove", id: s.id, expected: scheduleVersion(s) }); }}><Trash2 size={11} aria-hidden="true" /></button>}</li>)}</ul>}
    {!!bond?.knows.length && <><small className="sx-label">Знает</small><ul className="sx-knows">{bond.knows.map((k, i) => <li key={`${k.turn}-${i}`}>{k.text} <a href={`#turn-${k.turn}`}>ход {k.turn}</a>{k.source === "owner" && <span className="sx-owner" title="Указано владельцем кампании"> · владелец</span>}
      {editable && <button type="button" className="sx-remove" aria-label={`Снять знание: ${k.text}`} title="Снять запись знания" disabled={busy} onClick={() => { void send({ op: "knowledge.remove", npcKey, index: i, expected: { text: k.text, turn: k.turn, source: k.source ?? "scene" } }); }}><Trash2 size={11} aria-hidden="true" /></button>}</li>)}</ul></>}
    {!!bond?.history.length && <><small className="sx-label">Что было между вами</small><ol className="sx-history">{[...bond.history].reverse().map((h, i) => <li key={`${h.turn}-${i}`} className={h.delta > 0 ? "is-pos" : h.delta < 0 ? "is-neg" : ""}>
      <span className="sx-kind">{BOND_KIND_LABELS[h.kind]}</span> {h.text}{h.delta ? <strong> {h.delta > 0 ? "+" : "−"}{Math.abs(h.delta)}</strong> : null}{" "}
      <a href={`#turn-${h.turn}`} aria-label={`Перейти к ходу ${h.turn}`}><Link2 size={10} aria-hidden="true" />ход {h.turn}</a>
    </li>)}</ol></>}
    {editable && <div className="sx-edit">
      {mode === "none" && <div className="ax-actions">
        <button type="button" className="button secondary sx-btn" disabled={busy} onClick={() => { setEditingSlot(null); setMode("slot"); }}><Plus size={12} aria-hidden="true" /> Окно распорядка</button>
        <button type="button" className="button secondary sx-btn" disabled={busy} onClick={() => setMode("know")}><Plus size={12} aria-hidden="true" /> Знание</button>
      </div>}
      {mode === "slot" && <form className="ax-form" onSubmit={(e) => { e.preventDefault(); void send({ op: "schedule.upsert", ...editingSlot, npcKey, place: slotForm.place, from: slotForm.from, to: slotForm.to, repeat: slotForm.repeat, day: slotForm.repeat === "once" ? Number(slotForm.day) : null, note: slotForm.note }); }}>
        <label>Место<input disabled={busy} required maxLength={160} value={slotForm.place} onChange={(e) => setSlotForm({ ...slotForm, place: e.target.value })} placeholder="Название известного места" /></label>
        <div className="sx-row">
          <label>С<input disabled={busy} type="time" required value={slotForm.from} onChange={(e) => setSlotForm({ ...slotForm, from: e.target.value })} /></label>
          <label>До<input disabled={busy} type="time" required value={slotForm.to} onChange={(e) => setSlotForm({ ...slotForm, to: e.target.value })} /></label>
          <label>Повтор<select disabled={busy} value={slotForm.repeat} onChange={(e) => setSlotForm({ ...slotForm, repeat: e.target.value as "daily" | "once" })}><option value="daily">Ежедневно</option><option value="once">Один раз</option></select></label>
          {slotForm.repeat === "once" && <label>День мира<input disabled={busy} type="number" min={1} max={1000000} required value={slotForm.day} onChange={(e) => setSlotForm({ ...slotForm, day: e.target.value })} /></label>}
        </div>
        <label>Заметка<input disabled={busy} maxLength={200} value={slotForm.note} onChange={(e) => setSlotForm({ ...slotForm, note: e.target.value })} placeholder="Необязательно" /></label>
        <div className="ax-actions"><button type="submit" className="button primary sx-btn" disabled={busy}>Сохранить</button><button type="button" className="button secondary sx-btn" disabled={busy} onClick={() => setMode("none")}>Отмена</button></div>
      </form>}
      {mode === "know" && <form className="ax-form" onSubmit={(e) => { e.preventDefault(); void send({ op: "knowledge.add", npcKey, text: knowText }); }}>
        <label>Что знает персонаж<input disabled={busy} required maxLength={200} value={knowText} onChange={(e) => setKnowText(e.target.value)} placeholder="Короткий факт, известный этому персонажу" /></label>
        <div className="ax-actions"><button type="submit" className="button primary sx-btn" disabled={busy}>Сохранить</button><button type="button" className="button secondary sx-btn" disabled={busy} onClick={() => setMode("none")}>Отмена</button></div>
      </form>}
      {error && <p className="sx-error" role="alert">{error}</p>}
      <small className="sx-note">Правки владельца помечаются и попадают в память и промпт; отношения и историю связи они не меняют. Снятие записи знания не означает, что персонаж ничего об этом не знает.</small>
    </div>}
  </details>;
}
