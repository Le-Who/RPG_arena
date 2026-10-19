"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, Save, Sparkles } from "lucide-react";
import { api, jsonBody } from "@/lib/api-client";
import { formatModelPrice, getGeminiModelPrice, getKnownModelPrice } from "@/lib/model-pricing";
import { ModelChoice, type ModelChoiceEntry } from "./model-choice";
import { ModelPriceInfo } from "./model-price-info";
import { ContextualHelp } from "./contextual-help";

type Provider = "gemini" | "openrouter" | "pollinations";
type ProviderSettings = { provider: Provider; model: string; openrouterConfigured: boolean; pollinationsConfigured: boolean; pollinationsKeyExpiresAt?: string; useLiveAI: boolean };
const names: Record<Provider,string> = { gemini: "Gemini напрямую", openrouter: "OpenRouter", pollinations: "Pollinations" };
export function TextProviderSettings({ onDraftChange, onDirtyChange, onSaveReady, onSaved, connectionRevision = 0, expanded, onEdit, geminiConfigured = false, geminiProfile = "balanced", geminiModel = "gemini-3.5-flash-lite", onGeminiProfileChange, geminiProfileDirty = false, onSaveGeminiProfile, onCancelGeminiProfile }: {
  onDraftChange?: () => void; onDirtyChange: (dirty: boolean) => void; onSaveReady: (save: (() => Promise<boolean>) | null) => void;
  onSaved: (live: boolean, connectionChanged?: boolean) => void; connectionRevision?: number; expanded?: boolean; onEdit?: () => void;
  geminiConfigured?: boolean; geminiProfile?: string; geminiModel?: string; onGeminiProfileChange?: (profile: string) => void; geminiProfileDirty?: boolean; onSaveGeminiProfile?: () => Promise<boolean>; onCancelGeminiProfile?: () => void;
}) {
  const [saved,setSaved] = useState<ProviderSettings|null>(null), [provider,setProvider] = useState<Provider>("gemini"), [model,setModel] = useState(""), [live,setLive] = useState(false);
  const [editing,setEditing] = useState(false), [busy,setBusy] = useState(false), [loadingCatalog,setLoadingCatalog] = useState(false);
  const [error,setError] = useState(""), [message,setMessage] = useState(""), [catalogError,setCatalogError] = useState("");
  const [models,setModels] = useState<ModelChoiceEntry[]>([]);
  const [catalogProvider,setCatalogProvider] = useState<Provider|null>(null);
  const revision = useRef(0), catalogRequest = useRef(0), preferenceRequest = useRef(0), loaded = useRef(false), connectingRevision = useRef(0);
  const opened = expanded ?? editing;
  const changed = () => { revision.current++; onDraftChange?.(); setMessage(""); };
  const dirty = Boolean(saved && (provider !== saved.provider || model !== saved.model || live !== saved.useLiveAI));
  const load = useCallback(async (connectionOnly = false) => {
    const request = ++preferenceRequest.current;
    try { const data = await api<ProviderSettings>("/api/settings/text-provider"); if (request !== preferenceRequest.current) return;
      if (!loaded.current) { loaded.current = true; setProvider(data.provider); setModel(data.model); setLive(data.useLiveAI); setSaved(data); }
      else if (connectionOnly) setSaved(old => old ? {...old,openrouterConfigured:data.openrouterConfigured,pollinationsConfigured:data.pollinationsConfigured,pollinationsKeyExpiresAt:data.pollinationsKeyExpiresAt} : data);
      setError("");
    } catch { if (request === preferenceRequest.current) setError("Не удалось загрузить настройки рассказчика."); }
  }, []);
  const cancelRequests = useCallback(() => { preferenceRequest.current++; catalogRequest.current++; }, []);
  useEffect(() => { let active = true; void Promise.resolve().then(() => { if (active) void load(); }); return () => { active = false; cancelRequests(); }; }, [load,cancelRequests]);
  const loadCatalog = useCallback(async () => {
    if (provider === "gemini") return;
    const request = ++catalogRequest.current; setLoadingCatalog(true); setCatalogError("");
    try { const result = await api<{models:ModelChoiceEntry[]}>(provider === "pollinations" ? "/api/settings/pollinations/models?kind=text" : "/api/settings/text-provider/models?provider=openrouter"); if (request === catalogRequest.current) { setModels(result.models); setCatalogProvider(provider); } }
    catch { if (request === catalogRequest.current) { setModels([]); setCatalogError("Не удалось загрузить модели. Повторите загрузку или укажите модель в дополнительных настройках."); } }
    finally { if (request === catalogRequest.current) setLoadingCatalog(false); }
  }, [provider]);
  useEffect(() => { catalogRequest.current++; let active = true; void Promise.resolve().then(() => { if (!active) return; setLoadingCatalog(false); if (opened) void loadCatalog(); }); return () => { active = false; }; }, [opened,provider,loadCatalog,connectionRevision]);
  useEffect(() => { void Promise.resolve().then(() => setModels([])); }, [provider,connectionRevision]);
  useEffect(() => { if (connectionRevision && connectingRevision.current !== connectionRevision) { connectingRevision.current = connectionRevision; void Promise.resolve().then(() => load(true)); } }, [connectionRevision,load]);
  useEffect(() => { onDirtyChange(dirty); }, [dirty,onDirtyChange]);
  const save = useCallback(async () => {
    if (!saved) return false; if (!dirty && !geminiProfileDirty) return true; if (busy) return false;
    if (provider !== "gemini" && !model.trim()) { setError("Выберите модель рассказчика."); return false; }
    const submitted = revision.current, submittedConnection = preferenceRequest.current;
    setBusy(true); setError(""); setMessage("");
    try { if (provider === "gemini" && geminiProfileDirty && onSaveGeminiProfile && !await onSaveGeminiProfile()) return false;
      if (!dirty) { setMessage("Настройки рассказчика сохранены."); return true; }
      const data = await api<ProviderSettings>("/api/settings/text-provider",jsonBody({provider,model:model.trim(),useLiveAI:live}));
      setSaved(old => submittedConnection !== preferenceRequest.current && old ? {...data,openrouterConfigured:old.openrouterConfigured,pollinationsConfigured:old.pollinationsConfigured,pollinationsKeyExpiresAt:old.pollinationsKeyExpiresAt} : data);
      onSaved(data.useLiveAI);
      if (submitted !== revision.current) { setMessage("Сохранено. Новые изменения ещё не применены."); return false; }
      setProvider(data.provider); setModel(data.model); setLive(data.useLiveAI); setMessage("Настройки рассказчика сохранены."); return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить рассказчика."); return false; }
    finally { setBusy(false); }
  }, [saved,dirty,busy,provider,model,live,onSaved,geminiProfileDirty,onSaveGeminiProfile]);
  useEffect(() => { onSaveReady(save); return () => onSaveReady(null); }, [save,onSaveReady]);
  const [clock,setClock] = useState(() => Date.now());
  const expiry = saved?.pollinationsKeyExpiresAt ? Date.parse(saved.pollinationsKeyExpiresAt) : NaN;
  useEffect(() => { if (!Number.isFinite(expiry) || expiry <= clock) return; const timer = window.setTimeout(() => setClock(Date.now()),Math.min(expiry-clock,2_147_483_647)); return () => window.clearTimeout(timer); },[expiry,clock]);
  const expired = Boolean(saved?.pollinationsKeyExpiresAt && Date.parse(saved.pollinationsKeyExpiresAt) <= clock);
  const configured = provider === "gemini" ? geminiConfigured : provider === "openrouter" ? saved?.openrouterConfigured : saved?.pollinationsConfigured && !expired;
  const activeModels = catalogProvider === provider ? models : [];
  const chosen = activeModels.find(item => item.id === model);
  const price = provider === "gemini" ? getGeminiModelPrice(geminiModel,clock) : chosen?.price ?? getKnownModelPrice(provider,"text",model,undefined,clock);
  return <section className="settings-card ai-task-card" id="text-provider" aria-labelledby="text-provider-heading">
    <div className="settings-card-heading"><span className="feature-icon violet"><Sparkles size={20}/></span><div><h3 id="text-provider-heading" tabIndex={-1}>Рассказчик</h3><p>{saved ? names[provider] : "Загружаем настройки…"}{model ? ` · ${chosen?.name ?? model}` : ""}</p></div><button className="text-button" type="button" aria-label="Изменить рассказчика" aria-expanded={opened} onClick={() => { if (onEdit) onEdit(); else setEditing(value=>!value); }}>Изменить</button></div>
    {saved && <><div className="ai-price-summary"><p className="ai-task-price">{formatModelPrice(price)}</p><ContextualHelp title="Стоимость рассказчика"><ModelPriceInfo price={price}/></ContextualHelp></div><div className="ai-task-status" role="status">{(dirty || (provider === "gemini" && geminiProfileDirty)) && <span>Не применено</span>}{!configured && <span>Нужно подключить {names[provider]}</span>}{!live && <span>Базовый режим</span>}</div></>}
    {!saved && error && <><p role="alert">{error}</p><button type="button" className="button secondary" onClick={()=>void load()}>Повторить загрузку рассказчика</button></>}
    <div hidden={!opened || !saved} className="ai-task-editor">
      <label className="field"><span>Сервис</span><select aria-label="Провайдер рассказчика" value={provider} disabled={busy} onChange={event=>{changed();const next=event.target.value as Provider;setProvider(next);setModel(next===saved?.provider ? saved.model : "");setError("");}}>{Object.entries(names).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
      {provider === "gemini" ? <><label className="field"><span>Профиль Gemini</span><select aria-label="Профиль Gemini" value={geminiProfile} onChange={event=>{onDraftChange?.();onGeminiProfileChange?.(event.target.value);}} disabled={!onGeminiProfileChange || busy}><option value="economy">Лёгкое перо · Flash-Lite</option><option value="balanced">Золотая середина · Flash-Lite и Flash</option><option value="flagship">Большой роман · Flash</option>{geminiProfile === "custom" && <option value="custom">Свои модели</option>}</select></label></> : <><ModelChoice models={activeModels} selected={model} label="Модель рассказчика" disabled={busy} onChange={item=>{changed();setModel(item.id);}}/>{loadingCatalog && <p role="status"><LoaderCircle size={14} className="spin"/> Загружаем модели…</p>}{catalogError && <p role="status">{catalogError}</p>}<button type="button" className="text-button" disabled={loadingCatalog} onClick={()=>void loadCatalog()}>Обновить модели рассказчика</button><details className="advanced-models"><summary>Дополнительные настройки модели</summary><label className="field"><span>ID модели</span><input aria-label="Идентификатор модели рассказчика" value={model} maxLength={200} disabled={busy} onChange={event=>{changed();setModel(event.target.value);}} /></label></details></>}
      <div className="setting-toggle-row"><div><h3>Живой рассказчик</h3><p>Создавать новые ходы с выбранным ИИ.</p></div><button type="button" className={`toggle-switch ${live ? "on" : ""}`} role="switch" aria-checked={live} aria-label="Живой рассказчик" disabled={busy} onClick={()=>{changed();setLive(value=>!value);}}><span/></button></div>
      {!configured && <p className="notice">Подключите сервис в разделе «Подключённые сервисы».</p>}
      {error && saved && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
      <div className="ai-task-actions"><button type="button" className="button secondary" disabled={busy || (!dirty && !(provider === "gemini" && geminiProfileDirty))} onClick={()=>void save()}>{busy ? <LoaderCircle size={14} className="spin"/> : <Save size={14}/>}Сохранить рассказчика</button><button type="button" className="text-button" disabled={busy || (!dirty && !(provider === "gemini" && geminiProfileDirty))} onClick={()=>{if(!saved)return;changed();onCancelGeminiProfile?.();setProvider(saved.provider);setModel(saved.model);setLive(saved.useLiveAI);setError("");}}>Отменить выбор рассказчика</button><ContextualHelp title="Рассказчик и память"><p>Настройка рассказчика не меняет иллюстрации. Ключи подключаются отдельно и используются обеими задачами там, где это поддерживается.</p><p>Поиск воспоминаний по смыслу требует отдельного подключения Gemini. Проверка повествования включается в дополнительных настройках и может расходовать свою квоту.</p></ContextualHelp></div>
    </div>
  </section>;
}
