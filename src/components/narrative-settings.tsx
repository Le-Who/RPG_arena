"use client";
import { useFeedbackState } from "./feedback";

import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, ShieldCheck } from "lucide-react";
import { api, jsonBody } from "@/lib/api-client";
import type { NarrativeSettingsView } from "@/lib/narrative-settings";
import { NARRATIVE_PROVIDERS, type NarrativeProvider } from "@/lib/narrative-verifier";
import { ContextualHelp } from "./contextual-help";

export function NarrativeSettings({ onDraftChange, onDirtyChange, onSaveReady }: {
  onDraftChange?: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaveReady: (save: (() => Promise<boolean>) | null) => void;
}) {
  const [saved, setSaved] = useState<NarrativeSettingsView | null>(null);
  const [provider, setProvider] = useState<NarrativeProvider>("openrouter");
  const [enabled, setEnabled] = useState(false);
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useFeedbackState<string>("", value => Boolean(value));
  const dirty = Boolean(saved && (provider !== saved.provider || enabled !== saved.enabled || key.trim() || clearKey));
  const load = useCallback(() => {
    return api<NarrativeSettingsView>("/api/settings/narrative").then(result => {
      setSaved(result); setProvider(result.provider); setEnabled(result.enabled); setError("");
    }).catch(() => setError("Не удалось загрузить настройки проверки."));
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  const save = useCallback(async () => {
    if (!dirty) return true;
    if (busy) return false;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await api<NarrativeSettingsView>("/api/settings/narrative", jsonBody({ provider, enabled, ...(key.trim() ? { key: key.trim() } : clearKey ? { clearKey: true } : {}) }));
      setSaved(result); setProvider(result.provider); setEnabled(result.enabled); setKey(""); setClearKey(false);
      setMessage("Настройки проверки сохранены.");
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось сохранить настройки проверки.");
      return false;
    } finally { setBusy(false); }
  }, [busy, clearKey, dirty, enabled, key, provider, setMessage]);
  useEffect(() => { onSaveReady(save); return () => onSaveReady(null); }, [onSaveReady, save]);
  const configured = Boolean(key.trim() || (saved?.configured && !clearKey && provider === saved.provider));
  return <section className="settings-card">
    <div className="settings-card-heading"><span className="feature-icon violet"><ShieldCheck size={20} /></span><div><h2>Проверка повествования</h2><p>Помогает замечать противоречия в истории.</p></div><ContextualHelp title="Как проверяется повествование"><p>Проверяются отдельные утверждения о последствиях действий и прошлом истории. Значимые утверждения появляются после проверки; обычное описание может появляться постепенно.</p><p>Сервис проверки: {NARRATIVE_PROVIDERS[provider].model}. Если ответ неоднозначный, подключается модель вашего рассказчика.</p><p>Если сервис недоступен, история продолжается без этой проверки. Причину можно посмотреть в диагностике. Рассказчик не заменяет недоступный сервис.</p></ContextualHelp></div>
    {!saved ? <>{error ? <><p role="alert">{error}</p><button className="button secondary" onClick={() => void load()}>Повторить загрузку</button></> : <p><LoaderCircle className="spin" size={16} /> Загрузка…</p>}</> : <>
      {saved.credentialIssue && <p className="notice" role="status">Сохранённый ключ проверки устарел или недоступен. Вставьте новый ключ или удалите старый и сохраните настройки проверки. Ваши кампании сохранены.</p>}
      <div className="fields"><label className="field"><span>Сервис проверки</span><select value={provider} disabled={busy} onChange={event => { onDraftChange?.(); setProvider(event.target.value as NarrativeProvider); setKey(""); setMessage(""); }}><option value="openrouter">OpenRouter</option><option value="typesafe">TypeSafe</option></select></label>
        <label className="field"><span>Отдельный API-ключ {provider === "openrouter" ? "OpenRouter" : "TypeSafe"}</span><input type="password" value={key} disabled={busy} autoComplete="off" spellCheck={false} maxLength={500} placeholder="Вставьте новый ключ" onChange={event => { onDraftChange?.(); setKey(event.target.value); setClearKey(false); setMessage(""); }} /></label></div>
      <p className="settings-footnote">Ключ доступен только вашему профилю. При смене сервиса сохранённый ключ проверки удаляется.</p>
      <p className="settings-footnote">Проверка расходует квоту и может замедлить ответ. Дополнительная проверка также использует квоту рассказчика.</p>
      {saved.configured && provider === saved.provider && <div className="saved-key"><code>{saved.maskedKey}</code><button className="button secondary" disabled={busy} onClick={() => { onDraftChange?.(); setClearKey(value => !value); setKey(""); }}>{clearKey ? "Отменить удаление" : "Удалить ключ при сохранении"}</button></div>}
      <div className="settings-divider" />
      <div className="setting-toggle-row"><div><h3>Проверять повествование</h3><p>Выборочно сверять важные утверждения с историей.</p></div><button className={`toggle-switch ${enabled ? "on" : ""}`} disabled={busy} role="switch" aria-checked={enabled} aria-label="Выборочная проверка повествования" onClick={() => { onDraftChange?.(); setEnabled(value => !value); }}><span /></button></div>
      <p className="settings-footnote">Используется ваш ключ проверки, а если его нет — доступный ключ администратора. При недоступности сервиса история продолжается без проверки.</p>
      {enabled && !configured && <p role="status">{saved.administratorAvailable ? "При сохранении будет использоваться ключ администратора." : "Нет ключа проверки: история продолжится без неё."}</p>}
      {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
      <button className="button secondary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? "Сохранение…" : "Сохранить проверку"}</button>
    </>}
  </section>;
}
