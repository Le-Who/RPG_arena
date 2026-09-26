"use client";
import { useEffect, useState } from "react";
import { BookOpenText, Copy, LoaderCircle, X } from "lucide-react";
import { api } from "@/lib/api-client";
import type { Recap } from "@/lib/recap";

/** NARR-9: «Ранее в истории» — детерминированное резюме перед продолжением. */
export function RecapCard({ sessionId, onClose, onNotify }: { sessionId: string; onClose: () => void; onNotify?: (message: string, error?: boolean) => void }) {
  const [recap, setRecap] = useState<Recap | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    api<{ recap: Recap }>(`/api/sessions/${sessionId}/recap`).then((r) => { if (!cancelled) setRecap(r.recap); }).catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Не удалось собрать резюме"); });
    return () => { cancelled = true; };
  }, [sessionId]);
  const copy = async () => {
    if (!recap) return;
    try { await navigator.clipboard.writeText(recap.markdown); onNotify?.("Резюме скопировано"); } catch { onNotify?.("Не удалось скопировать", true); }
  };
  return <section className="gx-recap" aria-labelledby="recap-title" aria-live="polite">
    <div className="gx-recap-head">
      <BookOpenText size={18} aria-hidden="true" />
      <div><h2 id="recap-title">{recap?.headline ?? "Ранее в истории"}</h2>{recap?.awayLabel && <small>Последний ход — {recap.awayLabel}. Сводка собрана из сохранённого состояния и памяти, без AI.</small>}</div>
      <div className="gx-recap-actions">
        {recap && <button type="button" className="gx-tool icon-only" onClick={() => void copy()} aria-label="Скопировать резюме" title="Скопировать"><Copy size={15} /></button>}
        <button type="button" className="gx-tool icon-only" onClick={onClose} aria-label="Скрыть резюме" title="Скрыть"><X size={15} /></button>
      </div>
    </div>
    {error && <p className="lx-error" role="alert">{error}</p>}
    {!recap && !error && <p className="gx-side-hint"><LoaderCircle size={14} className="spin" /> Собираем резюме…</p>}
    {recap && <div className="gx-recap-grid">
      {recap.sections.map((s) => <div key={s.id} className="gx-recap-section"><h3>{s.title}</h3><ul>{s.lines.map((line, i) => <li key={i}>{line}</li>)}</ul></div>)}
    </div>}
  </section>;
}
