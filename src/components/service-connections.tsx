"use client";
import { useFeedbackState } from "./feedback";
import { useCallback, useEffect, useRef, useState } from "react";
import { KeyRound, LoaderCircle, Save } from "lucide-react";
import { api, jsonBody } from "@/lib/api-client";
import { PollinationsConnect } from "./pollinations-connect";
import { ContextualHelp } from "./contextual-help";
import { Dialog } from "./dialog";

type Provider="gemini"|"openrouter"|"pollinations";
type Connections={geminiConfigured:boolean;openrouterConfigured:boolean;pollinationsConfigured:boolean;pollinationsKeyExpiresAt?:string;credentialIssues?:Provider[]};
type Draft={apiKey:string;clearKey:boolean};
const names:Record<Provider,string>={gemini:"Gemini",openrouter:"OpenRouter",pollinations:"Pollinations"};
const links:Record<Provider,string>={gemini:"https://aistudio.google.com/apikey",openrouter:"https://openrouter.ai/settings/keys",pollinations:"https://enter.pollinations.ai/keys"};
export function ServiceConnections({onDraftChange,onDirtyChange,onSaveReady,onSaved,beforeConnect, advancedKeyRevision = 0}:{onDraftChange?:()=>void;onDirtyChange:(dirty:boolean)=>void;onSaveReady:(save:(()=>Promise<boolean>)|null)=>void;onSaved:()=>void;beforeConnect:()=>Promise<boolean>;advancedKeyRevision?:number}) {
  const [data,setData]=useState<Connections|null>(null),[drafts,setDrafts]=useState<Partial<Record<Provider,Draft>>>({}),[editing,setEditing]=useState<Provider|null>(null),[busy,setBusy]=useState(false),[connecting,setConnecting]=useState(false),[error,setError]=useState(""),[message,setMessage]=useFeedbackState<string>("", value => Boolean(value)),[remove,setRemove]=useState<Provider|null>(null),[clock,setClock]=useState(()=>Date.now());
  const request=useRef(0),lock=useRef(false);
  const dirty=Object.values(drafts).some(value=>value?.apiKey.trim()||value?.clearKey);
  const expiry=data?.pollinationsKeyExpiresAt?Date.parse(data.pollinationsKeyExpiresAt):NaN;
  useEffect(()=>{if(!Number.isFinite(expiry)||expiry<=clock)return;const timer=window.setTimeout(()=>{setClock(Date.now());onSaved();},Math.min(expiry-clock,2_147_483_647));return()=>window.clearTimeout(timer);},[expiry,clock,onSaved]);
  const load=useCallback(async()=>{const current=++request.current;try{const result=await api<Connections>("/api/settings/provider-connections");if(current===request.current){setData(result);setError("");}}catch{if(current===request.current)setError("Не удалось загрузить подключения.");}},[]);
  const cancelRequests=useCallback(()=>{request.current++;},[]);
  useEffect(()=>{let active=true;void Promise.resolve().then(()=>{if(active)void load();});return()=>{active=false;cancelRequests();};},[load,cancelRequests]);
  useEffect(()=>{if(advancedKeyRevision)void Promise.resolve().then(load);},[advancedKeyRevision,load]);
  useEffect(()=>{onDirtyChange(dirty);},[dirty,onDirtyChange]);
  const change=useCallback((provider:Provider,value:Draft)=>{onDraftChange?.();setDrafts(old=>({...old,[provider]:value}));setMessage("");},[onDraftChange,setMessage]);
  const save=useCallback(async()=>{
    if(!data)return false;if(!dirty)return true;if(lock.current||connecting)return false;
    lock.current=true;let wrote=false;setBusy(true);setError("");setMessage("");
    try{for(const provider of ["gemini","openrouter","pollinations"] as Provider[]){const value=drafts[provider];if(!value||(!value.apiKey.trim()&&!value.clearKey))continue;
      const result=await api<Connections>("/api/settings/provider-connections",jsonBody({provider,...(value.clearKey?{clearKey:true}:{apiKey:value.apiKey.trim()})}));wrote=true;setData(result);
      setDrafts(old=>{if(old[provider]?.apiKey!==value.apiKey||old[provider]?.clearKey!==value.clearKey)return old;return {...old,[provider]:{apiKey:"",clearKey:false}};});
    }setMessage("Подключения сохранены.");return true;
    }catch(cause){setError(cause instanceof Error?cause.message:"Не удалось сохранить подключение.");return false;}
    finally{lock.current=false;setBusy(false);if(wrote)onSaved();}
  },[data,dirty,connecting,drafts,onSaved,setMessage]);
  useEffect(()=>{onSaveReady(save);return()=>onSaveReady(null);},[save,onSaveReady]);
  return <section className="settings-card service-connections" id="service-connections"><div className="settings-card-heading"><span className="feature-icon teal"><KeyRound size={20}/></span><div><h3>Подключённые сервисы</h3><p>Один ключ на сервис.</p></div><ContextualHelp title="Подключение сервисов"><p>OpenRouter и Pollinations могут одновременно обслуживать рассказчика и иллюстрации. Подключение ключа не меняет выбранные модели и не запускает генерацию.</p><p>Ключи хранятся зашифрованными на сервере и не возвращаются в браузер. Если удалить ключ сервиса, обе задачи потеряют доступ к нему до нового подключения.</p><p>Ключ Gemini также используется для поиска воспоминаний по смыслу. Несколько ключей Google и отдельная проверка повествования доступны в дополнительных настройках.</p></ContextualHelp></div>
    {!data&&!error&&<p role="status">Загружаем подключения…</p>}
    {data&&(["gemini","openrouter","pollinations"] as Provider[]).map(provider=>{const configured=data[`${provider}Configured`]&&!(provider==="pollinations"&&Number.isFinite(expiry)&&expiry<=clock),needsReplacement=data.credentialIssues?.includes(provider),draft=drafts[provider];return <div key={provider} className="service-connection-row"><div className="service-connection-summary"><strong>{names[provider]}</strong><span>{draft?.clearKey?"Будет отключён":needsReplacement?"Нужно сохранить ключ заново":configured?"Подключён":"Не подключён"}</span><button type="button" className="text-button" disabled={busy||connecting} aria-expanded={editing===provider} onClick={()=>setEditing(value=>value===provider?null:provider)}>{needsReplacement?"Заменить ключ":configured?"Изменить":"Подключить"} {names[provider]}</button></div>
      {needsReplacement&&!draft?.clearKey&&<p className="notice" role="status">Сохранённый ключ {names[provider]} устарел или недоступен. Вставьте и сохраните ключ заново. Ваши кампании сохранены, вход в аккаунт доступен.</p>}
      <div hidden={editing!==provider} className="service-connection-editor">
      {provider==="pollinations"&&<PollinationsConnect disabled={busy||connecting} configured={configured} beforeConnect={beforeConnect} onConnectingChange={setConnecting}/>}
      <label className="field"><span>API-ключ {names[provider]}</span><input type="password" aria-label={`API-ключ ${names[provider]}`} autoComplete="off" spellCheck={false} maxLength={4096} disabled={busy||connecting} value={draft?.apiKey??""} placeholder={configured?"Вставьте новый ключ для замены":"Вставьте ключ"} onChange={event=>{const apiKey=event.currentTarget.value;change(provider,{apiKey,clearKey:false});}}/></label>
      <div className="service-connection-links"><a href={links[provider]} target="_blank" rel="noreferrer">Получить ключ {names[provider]}</a>{configured&&<button type="button" className="text-button" disabled={busy||connecting} onClick={()=>setRemove(provider)}>Отключить {names[provider]}</button>}{draft?.clearKey&&<button type="button" className="text-button" onClick={()=>change(provider,{apiKey:"",clearKey:false})}>Отменить отключение</button>}</div>
    </div></div>;})}
    {error&&<p role="alert">{error}</p>}{!data&&error&&<button type="button" className="button secondary" onClick={()=>void load()}>Повторить загрузку подключений</button>}{message&&<p role="status">{message}</p>}
    {dirty&&<div className="ai-task-actions"><button type="button" className="button secondary" disabled={busy||connecting} onClick={()=>void save()}>{busy?<LoaderCircle size={14} className="spin"/>:<Save size={14}/>}Сохранить подключения</button><button type="button" className="text-button" disabled={busy||connecting} onClick={()=>{onDraftChange?.();setDrafts({});setMessage("");}}>Отменить изменения подключений</button></div>}
    {remove&&<Dialog title={`Отключить ${names[remove]}?`} onClose={()=>setRemove(null)}><p>После сохранения рассказчик и иллюстрации, использующие {names[remove]}, потеряют доступ к сервису. Выбранные модели сохранятся. Другой аккаунт не будет оплачивать запросы автоматически.</p>{remove==="gemini"&&<p>Поиск воспоминаний по смыслу также потребует нового подключения Gemini.</p>}<div className="ai-task-actions"><button type="button" className="button secondary" onClick={()=>setRemove(null)}>Оставить подключение</button><button type="button" className="button primary" onClick={()=>{change(remove,{apiKey:"",clearKey:true});setRemove(null);}}>Отключить при сохранении</button></div></Dialog>}
  </section>;
}
