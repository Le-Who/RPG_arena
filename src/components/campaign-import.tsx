"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, jsonBody } from "@/lib/api-client";
import type { Session } from "@/lib/ui-data";
import { useApp } from "./app-shell";
import { Dialog } from "./dialog";

export function CampaignImport() {
  const { refresh, notify, loading, identity } = useApp();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Retained across network failures and dialog closure: retry must never duplicate an import.
  const attempt = useRef<{ requestId: string; document: unknown } | null>(null);
  const selection = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function select(file?: File) {
    const ticket = ++selection.current;
    attempt.current = null; setName(""); setError("");
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) { setError("Файл больше 4 МиБ. Выберите JSON-экспорт Chronicle."); return; }
    try {
      const document: unknown = JSON.parse(await file.text());
      if (!mounted.current || ticket !== selection.current) return;
      if (!document || typeof document !== "object" || !("format" in document) || document.format !== "chronicle-campaign") throw new Error("Выберите JSON-экспорт кампании Chronicle, а не журнал Markdown.");
      attempt.current = { requestId: crypto.randomUUID(), document }; setName(file.name);
    } catch (cause) { if (ticket === selection.current) setError(cause instanceof Error ? cause.message : "Не удалось прочитать файл."); }
  }
  async function submit() {
    if (busy || !attempt.current) return;
    setBusy(true); setError("");
    try {
      const result = await api<{ session: Session; replay: boolean }>("/api/sessions/import", jsonBody(attempt.current));
      if (!mounted.current) return;
      attempt.current = null; setName(""); setOpen(false); await refresh();
      if (!mounted.current) return;
      notify(result.replay ? "Ранее импортированная кампания найдена." : "Кампания импортирована как приватная история.");
      router.push(`/play/${result.session.id}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось импортировать кампанию. Можно повторить запрос."); }
    finally { setBusy(false); }
  }
  return <><button className="button secondary" disabled={loading || !identity} onClick={() => setOpen(true)}>Импорт кампании</button>{open && <Dialog title="Импорт кампании" onClose={() => { if (!busy) setOpen(false); }}>
    <p className="dialog-intro">Продолжите историю из JSON-экспорта Chronicle. Новая кампания будет приватной. Ключи, настройки аккаунта и расходы не переносятся; поиск по памяти переиндексируется отдельно.</p>
    <label className="field"><span>JSON-файл · до 4 МиБ</span><input type="file" accept="application/json,.json" disabled={busy} onChange={event => void select(event.target.files?.[0])} /></label>
    {name && <p className="settings-footnote">Выбран файл: {name}</p>}{error && <p role="alert" className="notice error-notice">{error}</p>}
    <div className="dialog-actions"><button className="button secondary" disabled={busy} onClick={() => setOpen(false)}>Отмена</button><button className="button primary" disabled={busy || !name} onClick={() => void submit()}>{busy ? "Импортируем…" : "Импортировать"}</button></div>
  </Dialog>}</>;
}
