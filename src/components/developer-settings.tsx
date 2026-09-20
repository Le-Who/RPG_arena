"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, KeyRound, LoaderCircle, RefreshCw, Save, ShieldCheck, Trash2, Wifi } from "lucide-react";
import { api, jsonBody } from "@/lib/api-client";
import type { TypeSafeReport } from "@/lib/typesafe-report";
import type { SettingsPanelProps } from "./settings-panel";
import { useDirtyHistory } from "./use-dirty-history";

type TypeSafeSettings = {
  configured: boolean;
  storedConfigured: boolean;
  maskedKey: string | null;
  source: "env" | "stored" | "none";
  envOverride: boolean;
  pilotEnabled: boolean;
  model: "jev-1.13.0";
};

type TypeSafeResult = {
  id: string;
  campaignTitle: string;
  turnNumber: number;
  report: TypeSafeReport;
  completedAt: string;
};

function isTypeSafeResult(value: unknown): value is TypeSafeResult {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<TypeSafeResult>;
  const report = item.report as Partial<TypeSafeReport> | null | undefined;
  const statuses: TypeSafeReport["status"][] = ["no_key", "empty", "ok", "error"];
  return typeof item.id === "string"
    && typeof item.campaignTitle === "string"
    && typeof item.turnNumber === "number"
    && typeof item.completedAt === "string"
    && Boolean(report && typeof report === "object" && report.status && statuses.includes(report.status) && Array.isArray(report.evaluations) && typeof report.latencyMs === "number")
    && report!.evaluations!.every((evaluation) => Boolean(
      evaluation
      && typeof evaluation === "object"
      && typeof evaluation.factIndex === "number"
      && typeof evaluation.fact === "string"
      && typeof evaluation.evidence === "string"
      && typeof evaluation.choice === "string"
      && typeof evaluation.confidence === "number"
      && evaluation.probabilities
      && typeof evaluation.probabilities.supports === "number"
      && typeof evaluation.probabilities.contradicts === "number"
      && typeof evaluation.probabilities.unsupported === "number",
    ));
}

export function DeveloperSettings({ onClose, returnLabel = "Вернуться", onCloseReady }: SettingsPanelProps) {
  const router = useRouter();
  const [settings, setSettings] = useState<TypeSafeSettings | null>(null);
  const [pilotEnabled, setPilotEnabled] = useState(false);
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [results, setResults] = useState<TypeSafeResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<string | null>(null);
  const pendingHistoryLeave = useRef<(() => void) | null>(null);

  const loadResults = useCallback(async () => {
    const data = await api<{ results: unknown[] }>("/api/developer/typesafe/results");
    setResults(data.results.filter(isTypeSafeResult));
  }, []);
  useEffect(() => {
    Promise.all([api<TypeSafeSettings>("/api/developer/typesafe"), api<{ results: unknown[] }>("/api/developer/typesafe/results")])
      .then(([value, recent]) => { setSettings(value); setPilotEnabled(value.pilotEnabled); setResults(recent.results.filter(isTypeSafeResult)); })
      .catch((error) => setMessage({ ok: false, text: error instanceof Error ? error.message : "Не удалось загрузить настройки TypeSafe." }))
      .finally(() => setLoading(false));
  }, []);

  const dirty = settings !== null && (pilotEnabled !== settings.pilotEnabled || Boolean(key.trim()));
  const releaseHistory = useDirtyHistory(dirty, (leave) => {
    if (saving) return;
    pendingHistoryLeave.current = leave;
    setPendingTarget(null);
    setConfirmClose(true);
  }, onClose);
  const finishClose = useCallback((target: string | null) => {
    const historyLeave = pendingHistoryLeave.current;
    pendingHistoryLeave.current = null;
    setConfirmClose(false);
    setPendingTarget(null);
    if (target) releaseHistory(() => router.push(target));
    else if (historyLeave) historyLeave();
    else releaseHistory(onClose);
  }, [onClose, releaseHistory, router]);
  const requestClose = useCallback(() => {
    if (saving) return;
    pendingHistoryLeave.current = null;
    if (dirty) { setPendingTarget(null); setConfirmClose(true); }
    else releaseHistory(onClose);
  }, [dirty, onClose, releaseHistory, saving]);

  useEffect(() => { onCloseReady?.(requestClose); return () => onCloseReady?.(null); }, [onCloseReady, requestClose]);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    const guardLink = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target || anchor.download) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || url.href === window.location.href) return;
      event.preventDefault(); event.stopPropagation();
      pendingHistoryLeave.current = null;
      setPendingTarget(`${url.pathname}${url.search}${url.hash}`);
      setConfirmClose(true);
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", guardLink, true);
    return () => { window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", guardLink, true); };
  }, [dirty]);

  const save = async () => {
    setSaving(true); setMessage(null);
    try {
      const saved = await api<TypeSafeSettings>("/api/developer/typesafe", jsonBody({ pilotEnabled, ...(key.trim() ? { key } : {}) }));
      setSettings(saved); setPilotEnabled(saved.pilotEnabled); setKey("");
      setMessage({ ok: true, text: "Настройки TypeSafe сохранены." });
      return true;
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "Не удалось сохранить настройки TypeSafe." });
      return false;
    } finally { setSaving(false); }
  };
  const saveAndFinish = async () => { if (await save()) finishClose(pendingTarget); };
  const discardAndFinish = () => { setPilotEnabled(settings?.pilotEnabled ?? false); setKey(""); finishClose(pendingTarget); };
  const removeKey = async () => {
    setSaving(true); setMessage(null);
    try {
      const saved = await api<TypeSafeSettings>("/api/developer/typesafe", jsonBody({ clearKey: true }));
      setSettings(saved);
      setMessage({ ok: true, text: saved.envOverride ? "Сохранённый ключ удалён. Активен ключ TYPESAFE_API_KEY." : "Ключ TypeSafe удалён." });
    } catch (error) { setMessage({ ok: false, text: error instanceof Error ? error.message : "Не удалось удалить ключ." }); }
    finally { setSaving(false); }
  };
  const testConnection = async () => {
    setTesting(true); setMessage(null);
    try {
      const result = await api<{ model: string; latencyMs: number; verdict: string; confidence: number }>("/api/developer/typesafe/test", jsonBody({}));
      setMessage({ ok: true, text: `Подключение работает · ${result.model} · ${result.latencyMs} мс · ${result.verdict} (${Math.round(result.confidence * 100)}%)` });
    } catch (error) { setMessage({ ok: false, text: error instanceof Error ? error.message : "Подключение TypeSafe не удалось." }); }
    finally { setTesting(false); }
  };

  if (loading) return <div className="play-loading"><LoaderCircle className="spin" size={27} /><h2>Загружаем инструменты разработки…</h2></div>;
  if (!settings) return <div className="play-loading"><ShieldCheck size={27} /><h2>Не удалось загрузить инструменты разработки</h2><p>{message?.text}</p><div className="settings-close-actions"><button className="button primary" onClick={() => window.location.reload()}>Попробовать снова</button>{onClose && <button className="button secondary" onClick={onClose}>{returnLabel}</button>}</div></div>;
  return <div className="settings-page">
    {onClose && <div className="settings-return"><button className="button secondary" onClick={requestClose} disabled={saving}>{returnLabel}</button></div>}
    {confirmClose && <section className="notice settings-unsaved" role="alert"><div><strong>Есть несохранённые изменения</strong><p>Сохраните их перед переходом или продолжите редактирование.</p><div className="settings-close-actions"><button className="button primary" disabled={saving} onClick={() => void saveAndFinish()}>Сохранить и продолжить</button><button className="button secondary" disabled={saving} onClick={discardAndFinish}>Отбросить и продолжить</button><button className="text-button" onClick={() => { pendingHistoryLeave.current = null; setConfirmClose(false); setPendingTarget(null); }}>Продолжить редактирование</button></div></div></section>}
    <div className="page-heading"><div><div className="eyebrow">ДЛЯ РАЗРАБОТКИ</div><h1>Пилот проверки фактов Jev</h1><p>Теневой сигнал качества: оценки сохраняются отдельно и не меняют память кампании.</p></div><button className="button primary" disabled={saving || !dirty} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}Сохранить</button></div>
    <div className="settings-layout"><div className="settings-main">
      <section className="settings-card"><div className="settings-card-heading"><span className="feature-icon violet"><KeyRound size={20} /></span><div><h2>TypeSafe API</h2><p>Фиксированная модель jev-1.13.0, один пакет до шести проверок.</p></div><span className={`pill ${settings.configured ? "teal" : "amber"}`}>{settings.configured ? "Ключ настроен" : "Не подключено"}</span></div>
        <div className="key-input-row"><label className="field"><span>API-ключ TypeSafe</span><div className="password-input"><input type={showKey ? "text" : "password"} value={key} onChange={(event) => setKey(event.target.value)} maxLength={500} autoComplete="off" spellCheck={false} placeholder="Вставьте новый ключ" aria-label="API-ключ TypeSafe" /><button className="icon-button" onClick={() => setShowKey((value) => !value)} aria-label={showKey ? "Скрыть ключ" : "Показать ключ"}><KeyRound size={14} /></button></div></label><button className="button primary" disabled={saving || !key.trim()} onClick={() => void save()}>Сохранить ключ</button></div>
        {settings.maskedKey && <div className="saved-key"><ShieldCheck size={13} /><code>{settings.maskedKey}</code><span>{settings.source === "env" ? "TYPESAFE_API_KEY · приоритет" : "Сохранён на сервере"}</span>{settings.storedConfigured && <button className="icon-button" onClick={() => void removeKey()} disabled={saving} aria-label="Удалить сохранённый ключ TypeSafe"><Trash2 size={13} /></button>}</div>}
        <div className="settings-divider" /><div className="setting-toggle-row"><div><h3>Теневой пилот</h3><p>Проверять извлечённые факты после нормализации. Результат не влияет на сохранение.</p></div><button className={`toggle-switch ${pilotEnabled ? "on" : ""}`} role="switch" aria-checked={pilotEnabled} aria-label="Теневой пилот TypeSafe" onClick={() => setPilotEnabled((value) => !value)}><span /></button></div>
        <div className="connection-test"><button className="button secondary" disabled={testing || !settings.configured} onClick={() => void testConnection()}>{testing ? <LoaderCircle className="spin" size={14} /> : <Wifi size={14} />}{testing ? "Проверяем…" : "Проверить подключение"}</button><span>Реальный короткий запрос, даже если пилот выключен</span></div>
        {message && <div className={`notice ${message.ok ? "" : "error-notice"}`} role="status">{message.ok ? <Check size={15} /> : <ShieldCheck size={15} />}<p>{message.text}</p></div>}
      </section>
      <section className="settings-card"><div className="settings-card-heading"><span className="feature-icon teal"><RefreshCw size={20} /></span><div><h2>Последние проверки</h2><p>До 20 завершённых заданий с диагностикой Jev.</p></div><button className="button secondary" onClick={() => void loadResults().catch(() => setMessage({ ok: false, text: "Не удалось обновить результаты." }))}><RefreshCw size={13} />Обновить</button></div>
        {results.length === 0 ? <p className="settings-footnote">Результатов пока нет.</p> : results.map((item) => <details className="advanced-models" key={item.id}><summary><span><strong>{item.campaignTitle} · ход {item.turnNumber}</strong><small>{item.report.status} · {item.report.evaluations.length} оценок · {item.report.latencyMs} мс</small></span><span>{new Date(item.completedAt).toLocaleString("ru-RU")}</span></summary><div className="fields">{item.report.error && <div className="notice error-notice"><p>{item.report.error}</p></div>}{item.report.evaluations.map((evaluation) => <div className="setting-explainer" key={evaluation.factIndex}><div><strong>{evaluation.choice} · {Math.round(evaluation.confidence * 100)}%</strong><p>{evaluation.fact}</p><small>Цитата: «{evaluation.evidence}»</small><small>supports {Math.round(evaluation.probabilities.supports * 100)}% · contradicts {Math.round(evaluation.probabilities.contradicts * 100)}% · unsupported {Math.round(evaluation.probabilities.unsupported * 100)}%</small></div></div>)}</div></details>)}
      </section>
    </div><aside className="settings-aside"><div className="settings-card usage-card"><div className="side-section-title no-top-margin"><ShieldCheck size={14} />ГАРАНТИИ ПИЛОТА</div><p className="settings-footnote">Jev только оценивает поддержку фактов. Ошибка, тайм-аут или отсутствие ключа не отменяют сохранение канонической памяти.</p><div className="settings-divider" /><div className="usage-small"><span>Модель</span><strong>{settings.model}</strong></div><div className="usage-small"><span>Тайм-аут</span><strong>5 секунд</strong></div><div className="usage-small"><span>Повторные запросы</span><strong>0</strong></div></div></aside></div>
  </div>;
}
