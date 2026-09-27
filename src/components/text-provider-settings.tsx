"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, KeyRound, LoaderCircle, LockKeyhole, Sparkles } from "lucide-react";
import { api, jsonBody } from "@/lib/api-client";

type Provider = "gemini" | "openrouter" | "pollinations";
type ProviderSettings = {
  provider: Provider;
  model: string;
  openrouterConfigured: boolean;
  pollinationsConfigured: boolean;
  pollinationsKeyExpiresAt?: string;
  useLiveAI: boolean;
};
type CatalogModel = { id: string; name: string; structuredOutput: boolean; streaming: boolean };
const providers = {
  gemini: { title: "Gemini напрямую", catalog: "https://ai.google.dev/gemini-api/docs/models" },
  openrouter: { title: "OpenRouter", catalog: "https://openrouter.ai/models" },
  pollinations: { title: "Pollinations", catalog: "https://enter.pollinations.ai" },
};

export function TextProviderSettings({ onDirtyChange, onSaveReady, onSaved }: {
  onDirtyChange: (dirty: boolean) => void;
  onSaveReady: (save: (() => Promise<boolean>) | null) => void;
  onSaved: (useLiveAI: boolean) => void;
}) {
  const [saved, setSaved] = useState<ProviderSettings | null>(null);
  const [provider, setProvider] = useState<Provider>("gemini");
  const [model, setModel] = useState("");
  const [useLiveAI, setUseLiveAI] = useState(false);
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectAvailable, setConnectAvailable] = useState<boolean | null>(null);
  const [connectError, setConnectError] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [checkedAt, setCheckedAt] = useState(() => Date.now());
  const [catalogs, setCatalogs] = useState<Partial<Record<Provider, { models: CatalogModel[]; loading: boolean; error: string }>>>({});
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
  const loadConnect = useCallback(async () => {
    try { setConnectAvailable((await api<{ available: boolean }>("/api/settings/pollinations/connect")).available); setConnectError(""); }
    catch { setConnectAvailable(null); setConnectError("Не удалось проверить доступность входа Pollinations."); }
  }, []);
  useEffect(() => { void Promise.resolve().then(load); void Promise.resolve().then(loadConnect); }, [load, loadConnect]);
  const loadCatalog = useCallback(async (selected: Provider) => {
    setCatalogs(old => ({ ...old, [selected]: { models: old[selected]?.models ?? [], loading: true, error: "" } }));
    try {
      const result = await api<{ models: CatalogModel[] }>(`/api/settings/text-provider/models?provider=${selected}`);
      setCatalogs(old => ({ ...old, [selected]: { models: result.models, loading: false, error: "" } }));
    } catch {
      setCatalogs(old => ({ ...old, [selected]: { models: old[selected]?.models ?? [], loading: false, error: "Каталог недоступен. Идентификатор модели можно ввести вручную." } }));
    }
  }, []);
  useEffect(() => { if (provider !== "gemini") void Promise.resolve().then(() => loadCatalog(provider)); }, [loadCatalog, provider]);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  const save = useCallback(async () => {
    if (!saved) return false;
    if (!dirty) return true;
    if (busy || connecting) return false;
    if (provider !== "gemini" && !model.trim()) { setError("Укажите идентификатор модели рассказчика."); return false; }
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await api<ProviderSettings>("/api/settings/text-provider", jsonBody({
        provider, model: model.trim(), useLiveAI,
        ...(provider !== "gemini" && key.trim() ? { apiKey: key.trim() } : provider !== "gemini" && clearKey ? { clearKey: true } : {}),
      }));
      setSaved(result); setProvider(result.provider); setModel(result.model); setUseLiveAI(result.useLiveAI);
      setKey(""); setClearKey(false); setCheckedAt(Date.now()); onSaved(result.useLiveAI); setMessage("Настройки рассказчика сохранены.");
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить настройки рассказчика."); return false; }
    finally { setBusy(false); }
  }, [busy, clearKey, connecting, dirty, key, model, onSaved, provider, saved, useLiveAI]);
  useEffect(() => { onSaveReady(save); return () => onSaveReady(null); }, [onSaveReady, save]);
  const connect = async () => {
    if (busy || connecting || !connectAvailable) return;
    // Save the draft before leaving this page; API keys never enter the redirect URL.
    if (!await save()) return;
    setConnecting(true); setError(""); setMessage("");
    try {
      const result = await api<{ url: string }>("/api/settings/pollinations/connect", jsonBody({}));
      const url = new URL(result.url);
      if (url.protocol !== "https:" || url.hostname !== "enter.pollinations.ai") throw new Error("Сервер вернул неподдерживаемый адрес входа Pollinations.");
      window.location.assign(url.href);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось открыть вход Pollinations."); setConnecting(false); }
  };
  const configured = provider === "openrouter" ? saved?.openrouterConfigured : provider === "pollinations" ? saved?.pollinationsConfigured : false;
  const disabled = busy || connecting;
  return <section className="settings-card" id="text-provider" aria-labelledby="text-provider-heading">
    <div className="settings-card-heading"><span className="feature-icon violet"><Sparkles size={20} /></span><div><h2 id="text-provider-heading">Провайдер рассказчика</h2><p>Выберите сервис для повествования, действий и текстовой памяти.</p></div></div>
    {!saved ? <>{error ? <><p role="alert">{error}</p><button type="button" className="button secondary" onClick={() => void load()}>Повторить загрузку рассказчика</button></> : <p role="status"><LoaderCircle className="spin" size={16} /> Загрузка настроек рассказчика…</p>}</> : <>
      <div className="fields"><label className="field"><span>Провайдер рассказчика</span><select aria-label="Провайдер рассказчика" value={provider} disabled={disabled} onChange={event => {
        const next = event.target.value as Provider;
        setProvider(next); setModel(next === saved.provider ? saved.model : ""); setKey(""); setClearKey(false); setError(""); setMessage("");
      }}>{Object.entries(providers).map(([id, details]) => <option key={id} value={id}>{details.title}</option>)}</select></label>
        {provider !== "gemini" && <label className="field"><span>Идентификатор модели рассказчика</span><input aria-label="Идентификатор модели рассказчика" value={model} disabled={disabled} list={`text-models-${provider}`} maxLength={200} autoComplete="off" spellCheck={false} placeholder={provider === "openrouter" ? "Например, provider/model-name" : "Идентификатор из каталога Pollinations"} onChange={event => { setModel(event.target.value); setMessage(""); }} /><datalist id={`text-models-${provider}`}>{catalogs[provider]?.models.map(item => <option key={item.id} value={item.id}>{item.name}{item.structuredOutput ? " · JSON" : ""}{item.streaming ? " · поток" : ""}</option>)}</datalist></label>}
      </div>
      <div className="key-footnote"><a href={providers[provider].catalog} target="_blank" rel="noreferrer">Каталог моделей {providers[provider].title} <ExternalLink size={11} /></a></div>
      {provider !== "gemini" && <>{catalogs[provider]?.loading ? <p className="settings-footnote" role="status">Загружаем каталог моделей…</p> : catalogs[provider]?.error ? <><p className="settings-footnote" role="status">{catalogs[provider]?.error}</p><button type="button" className="text-button" disabled={disabled} onClick={() => void loadCatalog(provider)}>Повторить загрузку каталога</button></> : <p className="settings-footnote">Модель можно выбрать из подсказок или ввести её идентификатор вручную.</p>}</>}
      {provider !== "gemini" && <p className="settings-footnote">Для внешней модели действует локальный лимит «Flash · на модель в сутки» в настройках дневных лимитов. Число ключей Gemini не увеличивает этот бюджет.</p>}
      {provider === "gemini" ? <p className="settings-footnote">Ключи и модели прямого Gemini настраиваются ниже. Профиль маршрутизации выбирает модели для разных текстовых задач.</p> : <>
        <label className="field"><span>Новый API-ключ {providers[provider].title}</span><input type="password" value={key} disabled={disabled} autoComplete="off" spellCheck={false} maxLength={500} placeholder="Оставьте пустым, чтобы сохранить текущий ключ" onChange={event => { setKey(event.target.value); setClearKey(false); setMessage(""); }} /></label>
        <div className="key-footnote"><span><LockKeyhole size={12} />Ключ хранится на сервере и не возвращается в браузер</span></div>
        <div className="saved-key"><KeyRound size={13} /><span>{clearKey ? "Ключ будет удалён при сохранении" : provider === "pollinations" && configured && expired ? "Срок действия ключа истёк" : configured ? "Ключ настроен" : "Ключ не настроен"}</span>{configured && <button type="button" className="button secondary" disabled={disabled} onClick={() => { setClearKey(value => !value); setKey(""); setMessage(""); }}>{clearKey ? "Отменить удаление ключа" : "Удалить ключ рассказчика"}</button>}</div>
        {provider === "pollinations" && configured && !clearKey && expiresAt !== null && <p className="settings-footnote" role="status">{expired ? "Ключ Pollinations истёк" : "Ключ Pollinations действует до"}: {new Intl.DateTimeFormat("ru", { dateStyle: "medium", timeStyle: "short" }).format(expiresAt)}.{expired && " Подключите Pollinations заново или сохраните новый API-ключ."}</p>}
        {provider === "pollinations" && <><div className="connection-test"><button type="button" className="button secondary" disabled={disabled || connectAvailable !== true} onClick={() => void connect()}>{connecting ? <LoaderCircle className="spin" size={14} /> : <ExternalLink size={14} />}{connecting ? "Открываем Pollinations…" : "Подключить через Pollinations"}</button></div>
          {connectAvailable === false && <p className="settings-footnote" role="status">Вход через Pollinations требует настройки приложения на сервере. Пока можно сохранить API-ключ вручную.</p>}
          {connectAvailable === null && !connectError && <p role="status">Проверяем доступность входа Pollinations…</p>}
          {connectError && <><p role="alert">{connectError}</p><button type="button" className="text-button" disabled={disabled} onClick={() => void loadConnect()}>Повторить проверку входа</button></>}
        </>}
      </>}
      <div className="settings-divider" />
      <div className="setting-toggle-row"><div><h3>Живой рассказчик</h3><p>Использовать выбранный сервис для новых ходов.</p></div><button type="button" className={`toggle-switch ${useLiveAI ? "on" : ""}`} role="switch" aria-checked={useLiveAI} aria-label="Живой рассказчик" disabled={disabled} onClick={() => { setUseLiveAI(value => !value); setMessage(""); }}><span /></button></div>
      <p className="settings-footnote">Jev проверяет повествование и настраивается отдельно. Семантический поиск использует embeddings прямого Gemini: для него нужен ключ Gemini, даже если рассказчик работает через OpenRouter или Pollinations.</p>
      {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
      <button type="button" className="button secondary" disabled={disabled || !dirty} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" size={14} /> : <KeyRound size={14} />}{busy ? "Сохранение рассказчика…" : "Сохранить рассказчика"}</button>
    </>}
  </section>;
}
