/** Actual SettingsPanel fixture. No Next server, DB, user credentials or generation. */
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { launchFixtureBrowser } from './lib/launch-fixture-browser';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
async function main() {
const settings = {keysMasked:[],keysCount:0,envKeysCount:0,useLiveAI:true,canUseLive:false,textProvider:'gemini',textModel:'',routingProfile:'balanced',narrationModel:'gemini-3.5-flash-lite',customActionModel:'gemini-3.8-flash',compactionModel:'gemini-3.8-flash',fastTaskModel:'gemini-3.5-flash-lite',keysSharedProject:true,dailyEmbeddingLimit:500,dailyFlashLimit:20,dailyLiteLimit:500,enforceLimits:true,embeddingsEnabled:true,embeddingModel:'gemini-embedding-2',embeddingDims:768,semanticExtractionEnabled:true};
const output = resolve('output/playwright/provider-selection');
await mkdir(output,{recursive:true});
const appStub = `import React,{useState,useContext,createContext,useCallback} from 'react';const Context=createContext(null);export function useApp(){return useContext(Context)};export function FixtureApp({children}){const [settings,setSettings]=useState(${JSON.stringify(settings)});const [notices,setNotices]=useState([]);const notify=useCallback(text=>setNotices(old=>[...old,text]),[]);const refresh=useCallback(async()=>true,[]);return <Context.Provider value={{settings,workspace:{displayName:'Гость',favorites:[],reading:{textScale:'normal',measure:'normal',theme:'midnight',motion:'reduced'}},identity:null,administration:false,loading:false,refresh,acceptSettings:setSettings,notify,resolveNotification:()=>{},updateReading:async()=>{}}}>{children}<aside aria-label="Уведомления">{notices.map((text,i)=><p key={i}>{text}</p>)}</aside></Context.Provider>}`;
const bundle = await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{FixtureApp}from'fixture:app';import{SettingsPanel}from'./src/components/settings-panel';createRoot(document.getElementById('root')).render(<FixtureApp><SettingsPanel onClose={()=>document.body.dataset.closed='yes'} /></FixtureApp>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,platform:'browser',jsx:'automatic',tsconfig:'tsconfig.json',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'isolated-settings',setup(build){build.onResolve({filter:/(?:^|\/)app-shell$|^fixture:app$/},()=>({path:'app',namespace:'fixture'}));build.onResolve({filter:/^next\/(navigation|link)$/},args=>({path:args.path,namespace:'fixture'}));build.onResolve({filter:/^node:crypto$/},()=>({path:'crypto',namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='app'?appStub:args.path==='crypto'?'export function createHash(){throw Error("Server-only crypto")}':args.path==='next/navigation'?'const router={push(){}};export function useRouter(){return router}':'import React from "react";export default function Link({children,...props}){return <a {...props}>{children}</a>}',loader:'tsx',resolveDir:process.cwd()}));}}]});
const css = (await Promise.all(['globals','pages','preferences','dialogs'].map(name=>readFile(`src/app/${name}.css`,'utf8')))).join('\n').replace('@import "tailwindcss";','');
const server = createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/fixture.js'?'text/javascript':req.url==='/fixture.css'?'text/css':'text/html');res.end(req.url==='/fixture.js'?bundle.outputFiles[0].text:req.url==='/fixture.css'?css:'<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><body><main id="root" style="max-width:1200px;margin:auto;padding:12px"></main><script src="/fixture.js"></script></body></html>');});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
const browser = await launchFixtureBrowser(server, () => chromium.launch());
const checks:string[] = [], errors:string[] = [];
try {
  for (const width of [1280,390,320]) {
    const page = await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});
    page.on('pageerror',error=>errors.push(error.message));
    let narrator = {provider:'gemini',model:'',openrouterConfigured:true,pollinationsConfigured:true,useLiveAI:true};
    let images = {enabled:true,provider:'pollinations',endpoint:null as string|null,accountSource:'personal',model:'image/a',applicationModel:'image/application',applicationConfigured:true,pollinationsConfigured:true,openrouterConfigured:true};
    const connections = {geminiConfigured:false,openrouterConfigured:true,pollinationsConfigured:true};
    const writes:{path:string;body:Record<string,unknown>}[] = [];
    let catalogReads = 0;
    const metadataGate: {release?:()=>void} = {};
    let holdMetadata = false;
    const releasePending = () => { metadataGate.release?.(); metadataGate.release = undefined; };
    const price = (amount:number,unit='image')=>({currency:'USD',status:'fixed',amount,unit,rates:[],source:'https://example.invalid/catalog',checkedAt:'2026-10-19T12:00:00Z',conditions:[],complete:true});
    await page.route('**/api/**',async route=>{
      const request=route.request(),url=new URL(request.url());let data:unknown={};
      if(request.method()==='POST')writes.push({path:url.pathname,body:request.postDataJSON()});
      if(url.pathname==='/api/settings/text-provider'){if(request.method()==='POST')narrator={...narrator,...request.postDataJSON()};data=narrator;}
      else if(url.pathname==='/api/settings/visual-provider'){if(request.method()==='POST')images={...images,...request.postDataJSON()};data=images;}
      else if(url.pathname==='/api/settings/provider-connections'){if(request.method()==='POST'){const input=request.postDataJSON();connections[(input.provider+'Configured') as keyof typeof connections]=!input.clearKey;narrator={...narrator,openrouterConfigured:connections.openrouterConfigured,pollinationsConfigured:connections.pollinationsConfigured};images={...images,openrouterConfigured:connections.openrouterConfigured,pollinationsConfigured:connections.pollinationsConfigured};}data=connections;}
      else if(url.pathname==='/api/settings/visual-provider/models'){catalogReads++;const provider=url.searchParams.get('provider');if(holdMetadata&&url.searchParams.get('model')==='image/d')await new Promise<void>(resolve=>{metadataGate.release=resolve;});data={models:['a','b','c','d'].map((suffix,index)=>({id:`image/${suffix}`,name:`Иллюстрация ${suffix}`,endpoint:provider==='openrouter'&&suffix!=='d'?'seed':undefined,generationSupported:suffix!=='d',price:price(index/100+0.01)})),checkedAt:'2026-10-19T12:00:00Z',stale:false};}
      else if(url.pathname==='/api/settings/text-provider/models'||url.pathname==='/api/settings/pollinations/models'){catalogReads++;data={models:['a','b','c','d'].map((suffix,index)=>({id:`text/${suffix}`,name:`Рассказчик ${suffix}`,structuredOutput:true,streaming:true,price:price(index/100+0.01,'request')})),checkedAt:'2026-10-19T12:00:00Z',stale:false};}
      else if(url.pathname==='/api/settings/pollinations/connect'){if(request.method()==='POST'){await route.fulfill({status:503,json:{error:'Synthetic OAuth stop'}});return;}data={available:true};}
      else if(url.pathname==='/api/settings')data={...settings,textProvider:narrator.provider,textModel:narrator.model,useLiveAI:narrator.useLiveAI,canUseLive:narrator.useLiveAI&&connections[(narrator.provider+'Configured') as keyof typeof connections]};
      else if(url.pathname==='/api/account')data={account:null,guest:{campaigns:0}};
      else if(url.pathname==='/api/settings/narrative')data={enabled:false,active:false,provider:'openrouter',configured:false,maskedKey:null,model:'typesafe/jev-1.13',credentialSource:'none',administratorAvailable:false};
      else if(url.pathname==='/api/tokens/stats')data={today:{totalReq:0,totalTokens:0,errors:0,embeddingReq:0},quotas:{note:''}};
      else throw Error('Unexpected API '+url.pathname);
      if(url.pathname==='/api/settings/text-provider/models'||url.pathname==='/api/settings/pollinations/models'){(data as {models:unknown[]}).models.unshift({id:'text/community',name:'Вариант сообщества',community:true,price:price(0,'request')});}
      await route.fulfill({json:data});
    });
    await page.goto(base);
    await expect(page.getByRole('heading',{name:'ИИ для ваших историй',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Справка: Выбор ИИ',exact:true})).toBeVisible();
    await expect(page.getByRole('combobox',{name:'Провайдер рассказчика',exact:true})).toBeVisible();
    await expect(page.getByRole('combobox',{name:'Профиль Gemini',exact:true})).toBeVisible();
    await expect(page.getByRole('combobox',{name:'Модель Gemini для повествования',exact:true})).toBeVisible();
    await expect(page.getByRole('switch',{name:'Живой рассказчик',exact:true})).toBeChecked();
    await expect(page.locator('#text-provider .ai-task-status')).toContainText('Нужно подключить Gemini');
    await expect(page.locator('#text-provider .ai-task-status')).not.toContainText('Готов к генерации');
    checks.push(width+':visible-narrator-controls-live-preference-without-key');
    if(catalogReads)throw Error('Catalog blocks initial settings');
    checks.push(width+':lazy-catalog');
    const help=page.getByRole('button',{name:'Справка: Выбор ИИ',exact:true});await help.click();
    const dialog=page.getByRole('dialog',{name:'Выбор ИИ',exact:true});await expect(dialog).toBeVisible();await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(help).toBeFocused();checks.push(width+':help-focus');
    await page.getByRole('button',{name:'Изменить иллюстрации',exact:true}).click();
    await page.getByRole('combobox',{name:'Аккаунт для иллюстраций',exact:true}).selectOption('application');
    await expect(page.locator('#visual-provider .settings-card-heading')).toContainText('image/application');
    checks.push(width+':application-model-summary');
    await page.getByRole('combobox',{name:'Сервис иллюстраций',exact:true}).selectOption('openrouter');
    await expect(page.getByText('Иллюстрация a',{exact:true})).toBeVisible();
    await page.getByRole('radio',{name:/Иллюстрация b/}).check();
    const beforeConnectWrites=writes.length;
    await page.getByRole('button',{name:'Изменить Pollinations',exact:true}).click();
    await page.getByRole('button',{name:'Переподключить аккаунт Pollinations',exact:true}).click();
    await expect(page.getByText('Перед входом сохраните или отмените изменения настроек. Подключение не применяет их автоматически.',{exact:true})).toBeVisible();
    if(writes.length!==beforeConnectWrites)throw Error('OAuth unexpectedly applied role drafts');checks.push(width+':oauth-never-applies-role-drafts');
    await page.getByRole('button',{name:'Сохранить настройки иллюстраций',exact:true}).click();
    await expect(page.getByText('Настройки новых иллюстраций сохранены.',{exact:true})).toBeVisible();
    const imageWrite=writes.find(item=>item.path==='/api/settings/visual-provider');if(imageWrite?.body.provider!=='openrouter'||imageWrite.body.endpoint!=='seed'||writes.some(item=>item.path==='/api/settings/text-provider'))throw Error('Image setting changed narrator or lost endpoint');checks.push(width+':independent-images');
    await page.getByRole('combobox',{name:'Провайдер рассказчика',exact:true}).selectOption('openrouter');
    await page.getByRole('radio',{name:/Рассказчик a/}).check();
    await expect(page.getByRole('radio',{name:/Вариант сообщества/})).toHaveCount(0);checks.push(width+':official-shortlist');
    await page.getByRole('radio',{name:/Рассказчик a/}).focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');await expect(page.getByRole('radio',{name:/Рассказчик c/})).toBeChecked();await expect(page.getByRole('radio',{name:/Рассказчик c/})).toBeFocused();checks.push(width+':stable-keyboard-model-order');
    await page.getByRole('button',{name:'Все модели и поиск',exact:true}).first().click();
    await expect(page.getByRole('radio',{name:/Вариант сообщества/})).toBeVisible();await expect(page.locator('#text-provider').getByText('Модель сообщества',{exact:true})).toBeVisible();
    await page.getByRole('searchbox',{name:'Найти модель рассказчика'}).fill('Рассказчик d');
    await page.getByRole('radio',{name:/Рассказчик d/}).check();
    await page.getByRole('button',{name:'Короткий список',exact:true}).click();await expect(page.getByRole('radio',{name:/Рассказчик d/})).toBeChecked();checks.push(width+':search-pins-selected');
    await page.getByRole('button',{name:'Сохранить рассказчика',exact:true}).click();await expect(page.getByText('Настройки рассказчика сохранены.',{exact:true})).toBeVisible();
    await expect(page.locator('#text-provider .ai-task-status')).toContainText('Готов к генерации');
    if(images.provider!=='openrouter'||images.model!=='image/b')throw Error('Narrator changed image preferences');checks.push(width+':independent-narrator');
    const beforeKeys={narrator:{...narrator},images:{...images},writes:writes.length};
    await page.getByRole('button',{name:'Изменить OpenRouter',exact:true}).click();
    await page.getByRole('textbox',{name:'API-ключ OpenRouter',exact:true}).fill('synthetic-shared-key');
    await page.getByRole('button',{name:'Сохранить подключения',exact:true}).click();
    await expect(page.getByText('Подключения сохранены.',{exact:true})).toBeVisible();
    await expect(page.getByRole('textbox',{name:'API-ключ OpenRouter',exact:true})).toHaveValue('');
    if(writes.slice(beforeKeys.writes).some(item=>item.path!=='/api/settings/provider-connections')||narrator.model!==beforeKeys.narrator.model||images.model!==beforeKeys.images.model)throw Error('Shared key changed role preferences');checks.push(width+':shared-key-preserves-tasks');
    const remove=page.getByRole('button',{name:'Отключить OpenRouter',exact:true});await remove.click();
    await expect(page.getByRole('dialog',{name:'Отключить OpenRouter?',exact:true})).toBeVisible();await page.keyboard.press('Escape');await expect(remove).toBeFocused();
    await remove.click();await page.getByRole('button',{name:'Отключить при сохранении',exact:true}).click();await page.getByRole('button',{name:'Сохранить подключения',exact:true}).click();
    await expect(page.locator('#text-provider')).toContainText('Нужно подключить');await expect(page.locator('#visual-provider')).toContainText('Нужно подключить');
    expect(narrator.useLiveAI).toBe(true);await expect(page.getByRole('switch',{name:'Живой рассказчик',exact:true})).toBeChecked();
    await expect(page.locator('#text-provider .ai-task-status')).not.toContainText('Готов к генерации');
    if(narrator.model!==beforeKeys.narrator.model||images.model!==beforeKeys.images.model)throw Error('Disconnect reset preferences');checks.push(width+':shared-disconnect-both-tasks');
    await expect(page.getByRole('combobox',{name:'Сервис иллюстраций',exact:true})).toBeVisible();
    await page.locator('#visual-provider').getByRole('button',{name:'Все модели и поиск',exact:true}).click();
    await page.getByRole('searchbox',{name:'Найти модель иллюстраций'}).fill('Иллюстрация d');holdMetadata=true;
    await page.getByRole('radio',{name:/Иллюстрация d/}).check();
    await expect(page.getByText('Проверяем модель…',{exact:true})).toBeVisible();
    await page.locator('#visual-provider').getByText('Дополнительные настройки модели',{exact:true}).click();
    await page.getByRole('textbox',{name:'Идентификатор модели изображения',exact:true}).fill('image/c');
    await expect(page.getByRole('button',{name:'Проверить модель',exact:true})).toBeEnabled();
    holdMetadata=false;releasePending();checks.push(width+':manual-edit-cancels-endpoint-lookup');
    holdMetadata=true;metadataGate.release=undefined;
    await page.getByRole('radio',{name:/Иллюстрация d/}).check();await expect(page.getByText('Проверяем модель…',{exact:true})).toBeVisible();
    await page.getByRole('combobox',{name:'Сервис иллюстраций',exact:true}).selectOption('off');
    await expect(page.getByRole('button',{name:'Сохранить настройки иллюстраций',exact:true})).toBeEnabled();
    await page.getByRole('button',{name:'Сохранить настройки иллюстраций',exact:true}).click();holdMetadata=false;releasePending();
    await expect(page.locator('#visual-provider .settings-card-heading')).toContainText('Выключены');checks.push(width+':disable-during-endpoint-lookup');
    await page.screenshot({path:`${output}/${width}.png`,fullPage:true});
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);if(overflow)throw Error('Horizontal overflow '+width);checks.push(width+':responsive');
    await page.close();
  }
  if(errors.length)throw Error(errors.join('\n'));
  await writeFile(`${output}/result.json`,JSON.stringify({checks,errors,scope:'actual SettingsPanel; synthetic HTTP fixture; no real DB/provider calls'},null,2));
  console.log(JSON.stringify({checks:checks.length,errors}));
} catch(error) { console.error({pageErrors:errors}); throw error; } finally {await browser.close();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}

}
main().catch(error=>{console.error(error);process.exitCode=1;});
