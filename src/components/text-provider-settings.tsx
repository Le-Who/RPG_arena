"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, KeyRound, LoaderCircle, LockKeyhole, Sparkles } from "lucide-react";
import { api, jsonBody } from "@/lib/api-client";
import { PollinationsConnect } from "./pollinations-connect";

type Provider = "gemini" | "openrouter" | "pollinations";
type ProviderSettings = {
  provider: Provider;
  model: string;
  openrouterConfigured: boolean;
  pollinationsConfigured: boolean;
  pollinationsKeyExpiresAt?: string;
  useLiveAI: boolean;
};
type CatalogModel = { id: string; name: string; structuredOutput: boolean; streaming: boolean; paidOnly?: boolean };
const providers = {
  gemini: { title: "Gemini напрямую", catalog: "https://ai.google.dev/gemini-api/docs/models" },
  openrouter: { title: "OpenRouter", catalog: "https://openrouter.ai/models" },
  pollinations: { title: "Pollinations", catalog: "https://enter.pollinations.ai" },
};

export function TextProviderSettings({ onDraftChange, onDirtyChange, onSaveReady, onSaved }: {
  onDraftChange?: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaveReady: (save: (() => Promise<boolean>) | null) => void;
  onSaved: (useLiveAI: boolean, pollinationsChanged?: boolean) => void;
}) {
  const [saved, setSaved] = useState<ProviderSettings | null>(null);
  const [provider, setProvider] = useState<Provider>("gemini");
  const [model, setModel] = useState("");
  const [useLiveAI, setUseLiveAI] = useState(false);
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [checkedAt, setCheckedAt] = useState(() => Date.now());
  const [catalogs, setCatalogs] = useState<Partial<Record<Provider, { models: CatalogModel[]; loading: boolean; error: string; checkedAt?: string; stale?: boolean }>>>({});
  const catalogRequests = useRef<Partial<Record<Provider, number>>>({});
  const expiryValue = saved?.pollinationsKeyExpiresAt ? Date.parse(saved.pollinationsKeyExpiresAt) : NaN;
  const expiresAt = Number.isFinite(expiryValue) ? expiryValue : null;
  const expired = expiresAt !== null && expiresAt <= checkedAt;
  useEffect(() => {
    if (expiresAt === null || expiresAt <= checkedAt) return;
    const timer = window.setTimeout(() => setCheckedAt(Date.now()), Math.min(expiresAt - checkedAt, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [checkedAt, expiresAt]);
  const dirty = Boolean(saved && (provider !== saved.provider || model !== saved.model || useLiveAI !== saved.useLiveAI || key.trim() || clearKey));
  const load = useCallback(async () => {
    try {
      const result = await api<ProviderSettings>("/api/settings/text-provider");
      setSaved(result); setProvider(result.provider); setModel(result.model); setUseLiveAI(result.useLiveAI); setCheckedAt(Date.now()); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось загрузить настройки рассказчика."); }
  }, []);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);
  const loadCatalog = useCallback(async (selected: Provider, refresh = false) => {
    const request = (catalogRequests.current[selected] ?? 0) + 1;
    catalogRequests.current[selected] = request;
    setCatalogs(old => ({ ...old, [selected]: { models: old[selected]?.models ?? [], loading: true, error: "" } }));
    try {
      const result = await api<{ models: CatalogModel[]; checkedAt?: string; stale?: boolean }>(selected === "pollinations" ? `/api/settings/pollinations/models?kind=text${refresh ? "&refresh=1" : ""}` : `/api/settings/text-provider/models?provider=${selected}`);
      if (catalogRequests.current[selected] !== request) return;
      setCatalogs(old => ({ ...old, [selected]: { ...result, loading: false, error: "" } }));
    } catch {
      if (catalogRequests.current[selected] !== request) return;
      setCatalogs(old => ({ ...old, [selected]: { models: [], loading: false, error: "Каталог недоступен. Проверьте подключение аккаунта или введите ID модели вручную." } }));
    }
  }, []);
  useEffect(() => { if (provider !== "gemini") void Promise.resolve().then(() => loadCatalog(provider)); }, [loadCatalog, provider]);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  const save = useCallback(async (forConnect = false) => {
    if (!saved) return false;
    if (!dirty) return true;
    if (busy || connecting) return false;
    if (provider !== "gemini" && !model.trim() && !(forConnect && provider === "pollinations")) { setError("Выберите модель рассказчика из списка или укажите её ID вручную."); return false; }
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await api<ProviderSettings>("/api/settings/text-provider", jsonBody({
        provider, model: model.trim(), useLiveAI: forConnect && !model.trim() ? false : useLiveAI,
        ...(provider !== "gemini" && key.trim() ? { apiKey: key.trim() } : provider !== "gemini" && clearKey ? { clearKey: true } : {}),
      }));
      setSaved(result); setProvider(result.provider); setModel(result.model); setUseLiveAI(result.useLiveAI);
      setKey(""); setClearKey(false); setCheckedAt(Date.now()); onSaved(result.useLiveAI, provider === "pollinations" && (Boolean(key.trim()) || clearKey)); setMessage("Настройки рассказчика сохранены.");
      if (provider === "pollinations" && (key.trim() || clearKey)) void loadCatalog("pollinations", true);
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить настройки рассказчика."); return false; }
    finally { setBusy(false); }
  }, [busy, clearKey, connecting, dirty, key, loadCatalog, model, onSaved, provider, saved, useLiveAI]);
  useEffect(() => { onSaveReady(save); return () => onSaveReady(null); }, [onSaveReady, save]);
  const configured = provider === "openrouter" ? saved?.openrouterConfigured : provider === "pollinations" ? saved?.pollinationsConfigured : false;
  const disabled = busy || connecting;
  return <section className="settings-card" id="text-provider" aria-labelledby="text-provider-heading">
    <div className="settings-card-heading"><span className="feature-icon violet"><Sparkles size={20} /></span><div><h2 id="text-provider-heading" tabIndex={-1}>Провайдер рассказчика</h2><p>Выберите сервис для повествования, действий и текстовой памяти.</p></div></div>
    {!saved ? <>{error ? <><p role="alert">{error}</p><button type="button" className="button secondary" onClick={() => void load()}>Повторить загрузку рассказчика</button></> : <p role="status"><LoaderCircle className="spin" size={16} /> Загрузка настроек рассказчика…</p>}</> : <>
      <div className="fields"><label className="field"><span>Провайдер рассказчика</span><select aria-label="Провайдер рассказчика" value={provider} disabled={disabled} onChange={event => { onDraftChange?.();
        const next = event.target.value as Provider;
        setProvider(next); setModel(next === saved.provider ? saved.model : ""); setKey(""); setClearKey(false); setError(""); setMessage("");
      }}>{Object.entries(providers).map(([id, details]) => <option key={id} value={id}>{details.title}</option>)}</select></label>
      </div>
      {provider === "pollinations" && <PollinationsConnect disabled={disabled} configured={saved.pollinationsConfigured && !expired} beforeConnect={() => save(true)} onConnectingChange={setConnecting} />}
      {provider === "pollinations" && <label className="field"><span>Модель рассказчика</span><select aria-label="Модель рассказчика" value={model} disabled={disabled || catalogs.pollinations?.loading} onChange={event => { onDraftChange?.(); setModel(event.target.value); setMessage(""); }}>
        <option value="">Выберите модель</option>{model && !catalogs.pollinations?.models.some(item => item.id === model) && <option value={model}>{model} · задана вручную</option>}
        {catalogs.pollinations?.models.map(item => <option key={item.id} value={item.id}>{item.name} · {item.id}{item.structuredOutput ? " · JSON" : ""}{item.paidOnly ? " · платный Pollen" : ""}</option>)}
      </select></label>}
      <div className="fields">
        {provider !== "gemini" && <details className="advanced-models" open={provider === "openrouter" || undefined}><summary>Ввести ID модели вручную</summary><label className="field"><span>Идентификатор модели рассказчика</span><input aria-label="Идентификатор модели рассказчика" value={model} disabled={disabled} list={provider === "openrouter" ? "openrouter-models" : undefined} maxLength={200} autoComplete="off" spellCheck={false} placeholder="provider/model-name" onChange={event => { onDraftChange?.(); setModel(event.target.value); setMessage(""); }} /></label>{provider === "openrouter" && <datalist id="openrouter-models">{catalogs.openrouter?.models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</datalist>}</details>}
      </div>
      <div className="key-footnote"><a href={providers[provider].catalog} target="_blank" rel="noreferrer">Каталог моделей {providers[provider].title} <ExternalLink size={11} /></a></div>
      {provider !== "gemini" && <>{catalogs[provider]?.loading ? <p className="settings-footnote" role="status">Загружаем каталог моделей…</p> : catalogs[provider]?.error ? <><p className="settings-footnote" role="status">{catalogs[provider]?.error}</p><button type="button" className="text-button" disabled={disabled} onClick={() => void loadCatalog(provider)}>Повторить загрузку каталога</button></> : <p className="settings-footnote">Модель можно выбрать из подсказок или ввести её идентификатор вручную.</p>}</>}
      {provider === "pollinations" && <><button type="button" className="text-button" disabled={disabled || catalogs.pollinations?.loading} onClick={() => void loadCatalog("pollinations", true)}>Обновить модели рассказчика</button>{catalogs.pollinations?.checkedAt && <p className="settings-footnote" role="status">{catalogs.pollinations.stale ? "Сервис недоступен, показан сохранённый каталог" : "Каталог проверен"}: {new Date(catalogs.pollinations.checkedAt).toLocaleString("ru")}.</p>}</>}
      {provider !== "gemini" && <p className="settings-footnote">Для внешней модели действует локальный лимит «Flash · на модель в сутки» в настройках дневных лимитов. Число ключей Gemini не увеличивает этот бюджет.</p>}
      {provider === "gemini" ? <p className="settings-footnote">Ключи и модели прямого Gemini настраиваются ниже. Профиль маршрутизации выбирает модели для разных текстовых задач.</p> : <>
        <details className="advanced-models" open={provider === "openrouter" || undefined}><summary>Ввести API-ключ вручную</summary><label className="field"><span>Новый API-ключ {providers[provider].title}</span><input type="password" value={key} disabled={disabled} autoComplete="off" spellCheck={false} maxLength={500} placeholder="Оставьте пустым, чтобы сохранить текущий ключ" onChange={event => { onDraftChange?.(); setKey(event.target.value); setClearKey(false); setMessage(""); }} /></label></details>
        <div className="key-footnote"><span><LockKeyhole size={12} />Ключ хранится на сервере и не возвращается в браузер</span></div>
        <div className="saved-key"><KeyRound size={13} /><span>{clearKey ? "Ключ будет удалён при сохранении" : provider === "pollinations" && configured && expired ? "Срок действия ключа истёк" : configured ? "Ключ настроен" : "Ключ не настроен"}</span>{configured && <button type="button" className="button secondary" disabled={disabled} onClick={() => { onDraftChange?.(); setClearKey(value => !value); setKey(""); setMessage(""); }}>{clearKey ? "Отменить удаление ключа" : "Удалить ключ рассказчика"}</button>}</div>
        {provider === "pollinations" && <p className="settings-footnote">Подключение используется также для личных иллюстраций. Удаление ключа отключит оба назначения. Управлять бюджетом и отзывать доступ можно <a href="https://enter.pollinations.ai/keys" target="_blank" rel="noreferrer">в кабинете Pollinations</a>.</p>}
        {provider === "pollinations" && configured && !clearKey && expiresAt !== null && <p className="settings-footnote" role="status">{expired ? "Ключ Pollinations истёк" : "Ключ Pollinations действует до"}: {new Intl.DateTimeFormat("ru", { dateStyle: "medium", timeStyle: "short" }).format(expiresAt)}.{expired && " Подключите Pollinations заново или сохраните новый API-ключ."}</p>}
      </>}
      <div className="settings-divider" />
      <div className="setting-toggle-row"><div><h3>Живой рассказчик</h3><p>Использовать выбранный сервис для новых ходов.</p></div><button type="button" className={`toggle-switch ${useLiveAI ? "on" : ""}`} role="switch" aria-checked={useLiveAI} aria-label="Живой рассказчик" disabled={disabled} onClick={() => { onDraftChange?.(); setUseLiveAI(value => !value); setMessage(""); }}><span /></button></div>
      <p className="settings-footnote">Jev проверяет повествование и настраивается отдельно. Семантический поиск использует embeddings прямого Gemini: для него нужен ключ Gemini, даже если рассказчик работает через OpenRouter или Pollinations.</p>
      {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
      <button type="button" className="button secondary" disabled={disabled || !dirty} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" size={14} /> : <KeyRound size={14} />}{busy ? "Сохранение рассказчика…" : "Сохранить рассказчика"}</button>
    </>}
  </section>;
}
