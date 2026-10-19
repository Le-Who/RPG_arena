"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, LoaderCircle, Save } from "lucide-react";
import { api, jsonBody } from "@/lib/api-client";
import { PollinationsConnect } from "./pollinations-connect";
import type { PollinationsModel } from "@/lib/pollinations-model-catalog";

type Preferences = { accountSource: "application" | "personal"; model: string; applicationModel: string; applicationConfigured: boolean; pollinationsConfigured: boolean; expiresAt?: string };
export function ImageProviderSettings({ onDraftChange, onDirtyChange, onSaveReady, connectionRevision = 0 }: { onDraftChange?: () => void; onDirtyChange: (dirty: boolean) => void; onSaveReady: (save: (() => Promise<boolean>) | null) => void; connectionRevision?: number }) {
  const [saved, setSaved] = useState<Preferences | null>(null), [source, setSource] = useState<Preferences["accountSource"]>("application"), [model, setModel] = useState("");
  const [models, setModels] = useState<PollinationsModel[]>([]), [catalogMessage, setCatalogMessage] = useState("");
  const [busy, setBusy] = useState(false), [connecting, setConnecting] = useState(false), [loadingCatalog, setLoadingCatalog] = useState(false);
  const [error, setError] = useState(""), [message, setMessage] = useState("");
  const [checkedAt, setCheckedAt] = useState(() => Date.now());
  const initialized = useRef(false), preferenceRequest = useRef(0), catalogRequest = useRef(0);
  const expiry = saved?.expiresAt ? Date.parse(saved.expiresAt) : NaN;
  useEffect(() => {
    if (!Number.isFinite(expiry) || expiry <= checkedAt) return;
    const timer = window.setTimeout(() => setCheckedAt(Date.now()), Math.min(expiry - checkedAt, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [expiry, checkedAt]);
  const dirty = Boolean(saved && (source !== saved.accountSource || model !== saved.model));
  const acceptConnection = useCallback((data: Preferences) => {
    if (!initialized.current) {
      initialized.current = true;
      setSaved(data); setSource(data.accountSource); setModel(data.model);
    } else {
      setSaved(old => old ? { ...old, pollinationsConfigured: data.pollinationsConfigured, expiresAt: data.expiresAt } : data);
    }
    setCheckedAt(Date.now()); setError("");
  }, []);
  const load = useCallback(async () => {
    const request = ++preferenceRequest.current;
    try { const data = await api<Preferences>("/api/settings/visual-provider"); if (request === preferenceRequest.current) acceptConnection(data); }
    catch { if (request === preferenceRequest.current) setError("Не удалось загрузить настройки иллюстраций."); }
  }, [acceptConnection]);
  const loadCatalog = useCallback(async (refresh = false) => {
    const request = ++catalogRequest.current;
    setLoadingCatalog(true);
    try {
      const result = await api<{ models: PollinationsModel[]; checkedAt: string; stale: boolean }>(`/api/settings/pollinations/models?kind=image${refresh ? "&refresh=1" : ""}`);
      if (request !== catalogRequest.current) return;
      setModels(result.models); setCatalogMessage(`${result.stale ? "Сервис недоступен, показан сохранённый каталог" : "Каталог проверен"}: ${new Date(result.checkedAt).toLocaleString("ru")}.`);
    } catch { if (request === catalogRequest.current) { setModels([]); setCatalogMessage("Каталог недоступен. Проверьте подключение Pollinations или введите ID модели вручную."); } }
    finally { if (request === catalogRequest.current) setLoadingCatalog(false); }
  }, []);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);
  useEffect(() => { if (source === "personal") void Promise.resolve().then(() => loadCatalog()); }, [source, loadCatalog]);
  useEffect(() => {
    if (!connectionRevision) return;
    const request = ++preferenceRequest.current;
    let active = true;
    // Updating the shared credential must not erase an unsaved image model or payer draft.
    void api<Preferences>("/api/settings/visual-provider").then(data => {
      if (!active || request !== preferenceRequest.current) return;
      acceptConnection(data);
      if (source === "personal") void loadCatalog(true);
    }).catch(() => { if (active && request === preferenceRequest.current) setError("Не удалось обновить состояние подключения Pollinations. Повторите загрузку настроек."); });
    return () => { active = false; };
  }, [connectionRevision, source, loadCatalog, acceptConnection]);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  const save = useCallback(async () => {
    if (!saved) return false;
    if (!dirty) return true;
    if (busy || connecting) return false;
    setBusy(true); setError(""); setMessage("");
    const request = preferenceRequest.current;
    try {
      const data = await api<Preferences>("/api/settings/visual-provider", jsonBody({ accountSource: source, model: model.trim() }));
      setSaved(old => request !== preferenceRequest.current && old ? { ...data, pollinationsConfigured: old.pollinationsConfigured, expiresAt: old.expiresAt } : data);
      setSource(data.accountSource); setModel(data.model); setMessage("Настройки новых иллюстраций сохранены."); return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить настройки иллюстраций."); return false; }
    finally { setBusy(false); }
  }, [saved, dirty, busy, connecting, source, model]);
  useEffect(() => { onSaveReady(save); return () => onSaveReady(null); }, [save, onSaveReady]);
  const expired = Number.isFinite(expiry) && expiry <= checkedAt;
  return <section className="settings-card" id="visual-provider" aria-labelledby="visual-provider-heading">
    <div className="settings-card-heading"><span className="feature-icon amber"><Camera size={20} /></span><div><h2 id="visual-provider-heading">Иллюстрации Pollinations</h2><p>Выберите аккаунт для оплаты новых изображений.</p></div></div>
    {!saved ? <>{error ? <><p role="alert">{error}</p><button type="button" className="button secondary" onClick={() => void load()}>Повторить загрузку иллюстраций</button></> : <p role="status">Загружаем настройки иллюстраций…</p>}</> : <>
      <label className="field"><span>Аккаунт для иллюстраций</span><select aria-label="Аккаунт для иллюстраций" disabled={busy || connecting} value={source} onChange={event => { onDraftChange?.(); setSource(event.target.value as Preferences["accountSource"]); setMessage(""); }}><option value="application">Аккаунт приложения Pollinations</option><option value="personal">Мой аккаунт Pollinations</option></select></label>
      {source === "application" ? <><p className="settings-footnote">Новые изображения оплачивает аккаунт приложения. Модель: <strong>{saved.applicationModel}</strong>. Её выбирает администратор.</p>{!saved.applicationConfigured && <p role="status" className="notice">Аккаунт приложения не подключён. Для генерации можно выбрать свой аккаунт Pollinations.</p>}</> : <>
        <PollinationsConnect disabled={busy || connecting} configured={saved.pollinationsConfigured && !expired} beforeConnect={save} onConnectingChange={setConnecting} />
        <p className="settings-footnote" role="status">{expired ? "Срок подключения истёк. Подключите аккаунт заново." : saved.pollinationsConfigured ? "Личный аккаунт подключён. Изображения расходуют ваш Pollen." : "Подключите личный аккаунт, чтобы создавать изображения за свой Pollen."}</p>
        <label className="field"><span>Модель личных иллюстраций</span><select aria-label="Модель личных иллюстраций" disabled={busy || loadingCatalog || connecting} value={model} onChange={event => { onDraftChange?.(); setModel(event.target.value); setMessage(""); }}>
          {!models.some(item => item.id === model) && <option value={model}>{model ? `${model} · задана вручную` : "Выберите модель"}</option>}
          {models.map(item => <option key={item.id} value={item.id}>{item.name} · {item.id}{item.paidOnly ? " · платный Pollen" : ""}</option>)}
        </select></label>
        <button type="button" className="text-button" disabled={busy || connecting || loadingCatalog} onClick={() => void loadCatalog(true)}>{loadingCatalog ? "Загружаем модели…" : "Обновить модели изображений"}</button>
        {catalogMessage && <p className="settings-footnote" role="status">{catalogMessage}</p>}
        <details className="advanced-models"><summary>Ввести ID модели изображения вручную</summary><label className="field"><span>Идентификатор модели изображения</span><input aria-label="Идентификатор модели изображения" value={model} disabled={busy || connecting} maxLength={200} autoComplete="off" spellCheck={false} onChange={event => { onDraftChange?.(); setModel(event.target.value); setMessage(""); }} /></label></details>
        <p className="settings-footnote">Список учитывает генерацию изображения по тексту и разрешения ключа. Доступ зависит от баланса и условий модели. Бюджет и отзыв доступа — <a href="https://enter.pollinations.ai/keys" target="_blank" rel="noreferrer">в кабинете Pollinations</a>.</p>
      </>}
      <p className="settings-footnote">Повтор создания использует аккаунт и модель, сохранённые у самой иллюстрации. При ошибке приложение не переключает аккаунт автоматически.</p>
      {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
      <button type="button" className="button secondary" style={{ maxWidth: "100%", whiteSpace: "normal", height: "auto", minHeight: 42 }} disabled={busy || connecting || !dirty} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}Сохранить настройки иллюстраций</button>
    </>}
  </section>;
}
