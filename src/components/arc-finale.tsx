"use client";
import { useState } from "react";
import { BookOpen, Download, Flag, GitBranch, Milestone, RotateCcw, Sparkles, Sun, X } from "lucide-react";
import type { WorldState } from "@/db/schema";
import { api } from "@/lib/api-client";
import { readArcHistory, readLife } from "@/lib/world-life";
import { readSocial } from "@/lib/world-social";

/** NARR-9b (2.9): экран завершённой арки и явное продолжение без потери канона. */
export function ArcFinale({ sessionId, world, turnCount, canEdit, disabled, onSaved, onBranch }: {
  sessionId: string; world: WorldState; turnCount: number; canEdit: boolean; disabled: boolean; onSaved: () => void; onBranch: () => void;
}) {
  const [mode, setMode] = useState<"idle" | "arc">("idle");
  const [draft, setDraft] = useState({ goal: "", stakes: "", conflict: "", endCondition: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const life = readLife(world);
  const story = life.story;
  if (story.kind !== "arc" || story.status !== "resolved") return null;
  const bonds = readSocial(world).bonds.filter((b) => b.history.length).length;
  const fulfilled = life.commitments.filter((c) => c.status === "fulfilled").length;
  const arcNumber = readArcHistory(world).length + 1;
  const save = async (body: Record<string, unknown>) => {
    setSaving(true); setError("");
    try { await api(`/api/sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify({ storyShape: body }) }); setMode("idle"); onSaved(); }
    catch (e) { setError(e instanceof Error ? e.message : "Не удалось сохранить"); }
    finally { setSaving(false); }
  };
  const field = (key: keyof typeof draft, label: string, placeholder: string) => <label>{label}<input maxLength={240} value={draft[key]} required placeholder={placeholder} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} /></label>;
  return <section className="ax-finale" aria-labelledby="arc-finale-title">
    <div className="ax-finale-head"><span className="ax-finale-icon"><Flag size={18} aria-hidden="true" /></span><div><small>Арка {arcNumber} завершена · ход {story.resolvedTurn ?? turnCount}</small><h2 id="arc-finale-title">{story.goal || "Цель достигнута"}</h2></div></div>
    {story.epilogue ? <p className="ax-epilogue">{story.epilogue}</p> : <p className="ax-epilogue is-muted">Эпилог не записан — история остановилась на достигнутой цели.</p>}
    <ul className="ax-stats" aria-label="Состояние кампании к финалу">
      <li><strong>{turnCount}</strong><span>ходов</span></li>
      <li><strong>{life.clock.day}</strong><span>{life.clock.day === 1 ? "день мира" : "дней мира"}</span></li>
      <li><strong>{bonds}</strong><span>связей с людьми</span></li>
      <li><strong>{fulfilled}</strong><span>выполненных договорённостей</span></li>
    </ul>
    {canEdit && mode === "idle" && <div className="ax-actions">
      <button type="button" className="button primary" disabled={saving || disabled} onClick={() => void save({ continueAs: "open-life" })}><Sun size={15} />Жить дальше — открытая жизнь</button>
      <button type="button" className="button secondary" disabled={saving || disabled} onClick={() => setMode("arc")}><Milestone size={15} />Новая арка</button>
      <button type="button" className="button secondary" disabled={saving || disabled} onClick={onBranch}><GitBranch size={15} />Развилка от финала</button>
      <button type="button" className="text-button" disabled={saving || disabled} onClick={() => void save({ reopen: true })}><RotateCcw size={14} />Вернуться в эту арку</button>
      <a className="text-button" href={`/api/sessions/${sessionId}/export?format=html`}><Download size={14} />Книга для чтения офлайн</a>
    </div>}
    {canEdit && mode === "arc" && <form className="ax-form" onSubmit={(e) => { e.preventDefault(); void save({ continueAs: "arc", ...draft }); }}>
      {field("goal", "Новая цель", "чего герой добивается теперь")}
      {field("stakes", "Ставки", "что можно потерять")}
      {field("conflict", "Конфликт", "что или кто мешает")}
      {field("endCondition", "Финал, когда", "условие завершения")}
      <div className="lx-row"><button type="submit" className="button primary" disabled={saving || disabled || Object.values(draft).some(v => !v.trim())}><Sparkles size={14} />Начать арку</button><button type="button" className="button secondary" disabled={saving || disabled} onClick={() => setMode("idle")}><X size={14} />Отмена</button></div>
    </form>}
    {error && <p className="lx-error" role="alert">{error}</p>}
    <small className="ax-note"><BookOpen size={12} aria-hidden="true" /> Завершённая арка остаётся каноном: ходы, память и связи сохраняются, рассказчик видит её итог.</small>
  </section>;
}
