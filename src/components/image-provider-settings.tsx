"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, LoaderCircle, Save } from "lucide-react";
import { api, jsonBody } from "@/lib/api-client";
import { formatModelPrice, getKnownModelPrice } from "@/lib/model-pricing";
import { ModelChoice, type ModelChoiceEntry } from "./model-choice";
import { ModelPriceInfo } from "./model-price-info";
import { ContextualHelp } from "./contextual-help";

type Provider = "pollinations" | "openrouter";
type Preferences = { enabled?: boolean; provider?: Provider; endpoint?: string|null; accountSource:"application"|"personal"; model:string; applicationModel:string; applicationConfigured:boolean; pollinationsConfigured:boolean; openrouterConfigured?:boolean; expiresAt?:string };
const normalized = (value:Preferences) => ({...value,enabled:value.enabled ?? true,provider:value.provider ?? "pollinations" as Provider,endpoint:value.endpoint ?? null});
export function ImageProviderSettings({onDraftChange,onDirtyChange,onSaveReady,connectionRevision=0,expanded,onEdit}:{onDraftChange?:()=>void;onDirtyChange:(dirty:boolean)=>void;onSaveReady:(save:(()=>Promise<boolean>)|null)=>void;connectionRevision?:number;expanded?:boolean;onEdit?:()=>void}) {
  const [saved,setSaved]=useState<ReturnType<typeof normalized>|null>(null),[enabled,setEnabled]=useState(true),[provider,setProvider]=useState<Provider>("pollinations"),[source,setSource]=useState<Preferences["accountSource"]>("application"),[model,setModel]=useState(""),[endpoint,setEndpoint]=useState<string|null>(null);
  const [editing,setEditing]=useState(false),[busy,setBusy]=useState(false),[loadingCatalog,setLoadingCatalog]=useState(false),[resolving,setResolving]=useState(false);
  const [catalogProvider,setCatalogProvider]=useState<Provider|null>(null);
  const [models,setModels]=useState<ModelChoiceEntry[]>([]),[catalogError,setCatalogError]=useState(""),[error,setError]=useState(""),[message,setMessage]=useState("");
  const initialized=useRef(false),revision=useRef(0),preferenceRequest=useRef(0),catalogRequest=useRef(0),selectionRequest=useRef(0);
  const opened=expanded ?? editing;
  const dirty=Boolean(saved && (enabled!==saved.enabled || provider!==saved.provider || source!==saved.accountSource || model!==saved.model || endpoint!==saved.endpoint));
  const changed=()=>{revision.current++;selectionRequest.current++;setResolving(false);onDraftChange?.();setMessage("");};
  const load=useCallback(async()=>{
    const request=++preferenceRequest.current;
    try{const data=normalized(await api<Preferences>("/api/settings/visual-provider"));if(request!==preferenceRequest.current)return;
      if(!initialized.current){initialized.current=true;setSaved(data);setEnabled(data.enabled);setProvider(data.provider);setSource(data.accountSource);setModel(data.model);setEndpoint(data.endpoint);}
      else setSaved(old=>old ? {...old,pollinationsConfigured:data.pollinationsConfigured,openrouterConfigured:data.openrouterConfigured,expiresAt:data.expiresAt,applicationConfigured:data.applicationConfigured,applicationModel:data.applicationModel} : data);
      setError("");
    }catch{if(request===preferenceRequest.current)setError("Не удалось загрузить настройки иллюстраций.");}
  },[]);
  const cancelRequests=useCallback(()=>{preferenceRequest.current++;catalogRequest.current++;selectionRequest.current++;},[]);
  useEffect(()=>{let active=true;void Promise.resolve().then(()=>{if(active)void load();});return()=>{active=false;cancelRequests();};},[load,cancelRequests]);
  useEffect(()=>{if(connectionRevision)void Promise.resolve().then(load);},[connectionRevision,load]);
  const loadCatalog=useCallback(async()=>{
    if(!enabled || (provider==="pollinations" && source==="application"))return;
    const request=++catalogRequest.current;setLoadingCatalog(true);setCatalogError("");
    try{const data=await api<{models:ModelChoiceEntry[]}>(`/api/settings/visual-provider/models?provider=${provider}${model ? `&model=${encodeURIComponent(model)}` : ""}${endpoint ? `&endpoint=${encodeURIComponent(endpoint)}` : ""}`);if(request===catalogRequest.current){setModels(data.models);setCatalogProvider(provider);}}
    catch{if(request===catalogRequest.current){setModels([]);setCatalogError("Не удалось загрузить модели. Повторите загрузку.");}}
    finally{if(request===catalogRequest.current)setLoadingCatalog(false);}
  },[enabled,provider,source,model,endpoint]);
  // A catalog response never selects a model or overwrites the current draft.
  const catalogLoad=useRef(loadCatalog);useEffect(()=>{catalogLoad.current=loadCatalog;},[loadCatalog]);
  useEffect(()=>{catalogRequest.current++;let active=true;void Promise.resolve().then(()=>{if(!active)return;setLoadingCatalog(false);if(opened)void catalogLoad.current();});return()=>{active=false;};},[opened,enabled,provider,source,connectionRevision]);
  useEffect(()=>{void Promise.resolve().then(()=>setModels([]));},[provider,source,connectionRevision]);
  useEffect(()=>{onDirtyChange(dirty);},[dirty,onDirtyChange]);
  const choose=async(item:ModelChoiceEntry)=>{
    changed();setError("");setModel(item.id);setEndpoint(item.endpoint??null);setResolving(false);
    if(provider!=="openrouter" || item.endpoint)return;
    const request=selectionRequest.current;setResolving(true);
    try{const data=await api<{models:ModelChoiceEntry[]}>(`/api/settings/visual-provider/models?provider=openrouter&model=${encodeURIComponent(item.id)}`);if(request!==selectionRequest.current)return;
      const resolved=data.models.find(candidate=>candidate.id===item.id && candidate.endpoint && candidate.generationSupported);
      if(!resolved){setError("Эта модель не подходит для создания картинки из текста. Выберите другую.");return;}
      setEndpoint(resolved.endpoint!);setModels(old=>old.map(candidate=>candidate.id===item.id?resolved:candidate));
    }catch{if(request===selectionRequest.current)setError("Не удалось проверить модель. Повторите выбор.");}
    finally{if(request===selectionRequest.current)setResolving(false);}
  };
  const save=useCallback(async()=>{
    if(!saved)return false;if(!dirty)return true;if(busy || resolving)return false;
    if(enabled && (!model.trim() || (provider==="openrouter" && !endpoint))){setError("Выберите подходящую модель иллюстраций.");return false;}
    const submitted=revision.current,connection=preferenceRequest.current;setBusy(true);setError("");setMessage("");
    try{const data=normalized(await api<Preferences>("/api/settings/visual-provider",jsonBody({enabled,provider,accountSource:source,model:model.trim(),endpoint})));
      setSaved(old=>connection!==preferenceRequest.current && old?{...data,pollinationsConfigured:old.pollinationsConfigured,openrouterConfigured:old.openrouterConfigured,expiresAt:old.expiresAt}:data);
      if(submitted!==revision.current){setMessage("Сохранено. Новые изменения ещё не применены.");return false;}
      setEnabled(data.enabled);setProvider(data.provider);setSource(data.accountSource);setModel(data.model);setEndpoint(data.endpoint);setMessage("Настройки новых иллюстраций сохранены.");return true;
    }catch(cause){setError(cause instanceof Error?cause.message:"Не удалось сохранить иллюстрации.");return false;}finally{setBusy(false);}
  },[saved,dirty,busy,resolving,enabled,provider,source,model,endpoint]);
  useEffect(()=>{onSaveReady(save);return()=>onSaveReady(null);},[save,onSaveReady]);
  const [clock,setClock]=useState(()=>Date.now());
  const expiry=saved?.expiresAt?Date.parse(saved.expiresAt):NaN;
  useEffect(()=>{if(!Number.isFinite(expiry)||expiry<=clock)return;const timer=window.setTimeout(()=>setClock(Date.now()),Math.min(expiry-clock,2_147_483_647));return()=>window.clearTimeout(timer);},[expiry,clock]);
  const expired=Boolean(saved?.expiresAt && Date.parse(saved.expiresAt)<=clock);
  const configured=provider==="openrouter"?saved?.openrouterConfigured:source==="application"?saved?.applicationConfigured:saved?.pollinationsConfigured&&!expired;
  const effectiveModel=provider==="pollinations"&&source==="application"?saved?.applicationModel??model:model;
  const activeModels=catalogProvider===provider?models:[];
  const chosen=activeModels.find(item=>item.id===effectiveModel&&(provider!=="openrouter"||item.endpoint===endpoint));
  const price=chosen?.price ?? getKnownModelPrice(provider,"image",effectiveModel,endpoint,clock);
  return <section className="settings-card ai-task-card" id="visual-provider" aria-labelledby="visual-provider-heading">
    <div className="settings-card-heading"><span className="feature-icon amber"><Camera size={20}/></span><div><h3 id="visual-provider-heading">Иллюстрации</h3><p>{!saved?"Загружаем настройки…":!enabled?"Выключены":`${provider==="openrouter"?"OpenRouter":"Pollinations"} · ${chosen?.name??effectiveModel}`}</p></div><button type="button" className="text-button" aria-label="Изменить иллюстрации" aria-expanded={opened} onClick={()=>{if(onEdit)onEdit();else setEditing(value=>!value);}}>Изменить</button></div>
    {saved && <><div className="ai-price-summary"><p className="ai-task-price">{enabled?formatModelPrice(price):"Нет расходов на картинки"}</p>{enabled&&<ContextualHelp title="Стоимость иллюстрации"><ModelPriceInfo price={price}/></ContextualHelp>}</div><div className="ai-task-status" role="status">{dirty&&<span>Не применено</span>}{enabled&&!configured&&<span>Нужно подключить сервис</span>}</div></>}
    {!saved&&error&&<><p role="alert">{error}</p><button type="button" className="button secondary" onClick={()=>void load()}>Повторить загрузку иллюстраций</button></>}
    <div hidden={!opened||!saved} className="ai-task-editor">
      <label className="field"><span>Сервис</span><select aria-label="Сервис иллюстраций" value={enabled?provider:"off"} disabled={busy} onChange={event=>{changed();const value=event.target.value;if(value==="off"){setEnabled(false);setResolving(false);setError("");return;}setEnabled(true);const next=value as Provider;setProvider(next);setResolving(false);if(next!==provider){setModel(saved?.provider===next?saved.model:"");setEndpoint(saved?.provider===next?saved.endpoint:null);}if(next==="openrouter"||!saved?.applicationConfigured)setSource("personal");setError("");}}><option value="off">Без генерации картинок</option><option value="pollinations">Pollinations</option><option value="openrouter">OpenRouter</option></select></label>
      {enabled&&<>{provider==="pollinations"&&<label className="field"><span>Кто оплачивает</span><select aria-label="Аккаунт для иллюстраций" value={source} disabled={busy} onChange={event=>{changed();setSource(event.target.value as Preferences["accountSource"]);setEndpoint(null);}}>{(saved?.applicationConfigured||source==="application")&&<option value="application">Аккаунт приложения{!saved?.applicationConfigured?" · недоступен":""}</option>}<option value="personal">Мой аккаунт Pollinations</option></select></label>}
      {provider==="pollinations"&&source==="application"?<p className="settings-footnote">Модель приложения: {saved?.applicationModel}. Её выбирает администратор.</p>:<><ModelChoice models={activeModels} selected={model} onChange={item=>void choose(item)} label="Модель иллюстраций" disabled={busy}/>{loadingCatalog&&<p role="status"><LoaderCircle size={14} className="spin"/> Загружаем модели…</p>}{resolving&&<p role="status">Проверяем модель…</p>}{catalogError&&<p role="status">{catalogError}</p>}<button type="button" className="text-button" disabled={loadingCatalog} onClick={()=>void loadCatalog()}>Обновить модели изображений</button><details className="advanced-models"><summary>Дополнительные настройки модели</summary><label className="field"><span>ID модели</span><input aria-label="Идентификатор модели изображения" value={model} maxLength={200} disabled={busy} onChange={event=>{changed();setModel(event.target.value);setEndpoint(null);}}/></label>{provider==="openrouter"&&<button type="button" className="button secondary" disabled={resolving||!model.trim()} onClick={()=>void choose({id:model.trim(),name:model.trim()})}>Проверить модель</button>}</details></>}
      <p className="ai-payer">Оплата: {source==="application"?"аккаунт приложения":`ваш аккаунт ${provider==="openrouter"?"OpenRouter":"Pollinations"}`}.</p>{!configured&&<p className="notice">Подключите выбранный сервис в разделе «Подключённые сервисы».</p>}</>}
      {error&&saved&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
      <div className="ai-task-actions"><button type="button" className="button secondary" disabled={busy||resolving||!dirty} onClick={()=>void save()}>{busy?<LoaderCircle size={14} className="spin"/>:<Save size={14}/>}Сохранить настройки иллюстраций</button><button type="button" className="text-button" disabled={busy||!dirty} onClick={()=>{if(!saved)return;changed();setEnabled(saved.enabled);setProvider(saved.provider);setSource(saved.accountSource);setModel(saved.model);setEndpoint(saved.endpoint);setResolving(false);setError("");}}>Отменить выбор иллюстраций</button><ContextualHelp title="Иллюстрации и оплата"><p>Эти настройки действуют на новые изображения. Повтор использует сервис, модель и аккаунт, выбранные при создании самой иллюстрации.</p><p>Ошибка не переключает оплату на другой аккаунт. OpenRouter работает через ваш личный ключ.</p><p>В режиме создания из текста исключаются модели, которым обязательно нужно исходное изображение.</p></ContextualHelp></div>
    </div>
  </section>;
}
