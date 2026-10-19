/** Actual AppShell, Dialog and settings components; isolated HTTP and virtual time. */
import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { settings } from "./ui-mock";
declare global {
  interface Window { notificationFixture: { notify: (text: string, error?: boolean | "warning", scope?: string) => void } }
}

async function main() {
  const output = "output/playwright/notification-feedback";
  await mkdir(output, { recursive: true });
  const bundle = await build({ stdin: { contents: `
    import React,{useState,useEffect} from "react";import {createRoot} from "react-dom/client";
    import {AppShell,useApp} from "./src/components/app-shell";import {Dialog} from "./src/components/dialog";
    import {StoryCreator} from "./src/components/story-creator";
    import {RecapCard} from "./src/components/recap-card";
    import {ServiceConnections} from "./src/components/service-connections";
    import {PollinationsConnectionNotice} from "./src/components/pollinations-connect";
    function Fixture(){const app=useApp();const {notify}=app;useEffect(()=>{window.notificationFixture=app},[app]);const [creator,setCreator]=useState(false);const [recapId,setRecapId]=useState(null);const [open,setOpen]=useState(false),[nested,setNested]=useState(false);
      const actions=<><button onClick={()=>notify('Не удалось сохранить действие.',true,'fixture-save')}>Сообщить ошибку</button><button onClick={()=>notify('Действие сохранено.',false,'fixture-save')}>Сообщить успех</button><button onClick={()=>notify('Другой результат готов.',false,'fixture-other')}>Другой успех</button></>;
      return <><h1>Проверка уведомлений</h1><button onClick={()=>setCreator(true)}>Создать историю</button>{creator&&<StoryCreator initialMode="free" live={true} onClose={()=>setCreator(false)} onCreated={()=>{}}/>}<output data-testid="owner">{app.identity?.profileId}</output><button onClick={()=>notify("Проверьте новые правки.","warning","fixture-warning")}>Важное предупреждение</button><button onClick={()=>setRecapId("failed")}>Загрузить резюме с ошибкой</button><button onClick={()=>setRecapId("ready")}>Открыть другое резюме</button>{recapId&&<RecapCard sessionId={recapId} onClose={()=>setRecapId(null)}/>}{actions}<button onClick={()=>setOpen(true)}>Открыть форму</button><ServiceConnections onDirtyChange={()=>{}} onSaveReady={()=>{}} onSaved={()=>{}} beforeConnect={async()=>true}/><PollinationsConnectionNotice/>{open&&<Dialog title="Форма" onClose={()=>setOpen(false)}>{actions}<button onClick={()=>setNested(true)}>Вложенная форма</button>{nested&&<Dialog title="Вложенная форма" onClose={()=>setNested(false)}>{actions}</Dialog>}</Dialog>}</>}
    createRoot(document.getElementById('root')).render(<AppShell><Fixture/></AppShell>);
  `, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "isolated-environment", setup(b) {
    b.onResolve({filter:/^(next\/link|next\/image|next\/navigation|\.\/settings-overlay|\.\/command-palette|\.\/pwa|\.\/app-update|node:crypto)$/}, a=>({path:a.path,namespace:"fixture"}));
    b.onLoad({filter:/.*/,namespace:"fixture"},a=>({loader:"tsx",resolveDir:process.cwd(),contents:
      a.path==="next/link"?'import React from "react";export default function Link(p){return <a {...p}/>;}':
      a.path==="next/image"?'export default function Image(){return null}':
      a.path==="next/navigation"?'const router={push:u=>history.pushState({},"",u),replace:u=>history.replaceState({},"",u)};export const useRouter=()=>router;export const usePathname=()=>"/";':
      a.path==="./settings-overlay"?'export const SettingsOverlay=()=>null;':a.path==="./command-palette"?'export const CommandPalette=()=>null;':a.path==="./pwa"?'export const InstallAppButton=()=>null;':a.path==="node:crypto"?'export function createHash(){throw Error("Server crypto forbidden")}':
      'import React from "react";export const AppUpdateProvider=({children})=><>{children}</>;export const useAppUpdateGuard=()=>null;'}));
  }}] });
  const css=(await Promise.all(["globals","shell","pages","preferences","dialogs"].map(n=>readFile(`src/app/${n}.css`,"utf8")))).join("\n").replace('@import "tailwindcss";','');
  const html='<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><body><div id="root"></div><script src="/app.js"></script></body></html>';
  const server=createServer((req,res)=>{res.setHeader("Content-Type",req.url==="/app.js"?"text/javascript":req.url==="/style.css"?"text/css":"text/html");res.end(req.url==="/app.js"?bundle.outputFiles[0].text:req.url==="/style.css"?css:html)});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const browser=await chromium.launch(), checks:string[]=[], errors:string[]=[];
  try {
    for(const width of [1280,390,320]){
      const page=await browser.newPage({viewport:{width,height:900},reducedMotion:"reduce"});
      page.on("pageerror",e=>errors.push(e.message)); await page.clock.install();
      let connected=false, profile="fixture-notifications";
      await page.route("**/api/**",async route=>{
        const path=new URL(route.request().url()).pathname;
        if(path==="/api/bootstrap")return route.fulfill({json:{ok:true,identity:{kind:"guest",profileId:profile,account:null,guestProfileId:profile,isAdmin:false,capabilities:{administration:false},pendingGuestCampaigns:0,passwordRecoveryAvailable:false},sessions:[],settings,workspace:{id:profile,displayName:"Гость",favorites:[],reading:{textScale:"normal",measure:"normal",theme:"midnight",motion:"reduced"}}}});
        if(path==="/api/story-drafts/autofill")return route.fulfill({status:503,json:{message:"Не удалось заполнить поля: проверьте подключение."}});
        if(path==="/api/sessions/failed/recap")return route.fulfill({status:503,json:{message:"Резюме временно недоступно"}});
        if(path==="/api/sessions/ready/recap")return route.fulfill({json:{recap:{headline:"Другое резюме",sections:[],markdown:"История"}}});
        if(path==="/api/settings/provider-connections"){if(route.request().method()==="POST")connected=true;return route.fulfill({json:{geminiConfigured:false,openrouterConfigured:connected,pollinationsConfigured:false}})}
        if(path==="/api/settings/pollinations/connect")return route.fulfill({json:{available:false}});
        return route.fulfill({status:501,json:{message:"Unexpected fixture request"}});
      });
      await page.goto(base);await page.getByRole("heading",{name:"Проверка уведомлений"}).waitFor();
      await page.getByRole("button",{name:"Сообщить ошибку",exact:true}).click();
      await expect(page.getByRole("alert")).toContainText("Не удалось сохранить действие.");
      await page.clock.fastForward(12000);await expect(page.getByRole("alert")).toBeVisible();
      await page.getByRole("button",{name:"Другой успех",exact:true}).click();
      await expect(page.getByRole("alert")).toBeVisible();await expect(page.getByText("Другой результат готов.",{exact:true})).toBeVisible();
      await page.clock.fastForward(6000);await expect(page.getByText("Другой результат готов.",{exact:true})).toHaveCount(0);await expect(page.getByRole("alert")).toBeVisible();
      await page.getByRole("button",{name:"Сообщить успех",exact:true}).click();await expect(page.getByRole("alert")).toHaveCount(0);
      await page.clock.fastForward(3000);await page.getByRole("button",{name:"Сообщить успех",exact:true}).click();await page.clock.fastForward(3000);await expect(page.getByText("Действие сохранено.",{exact:true})).toBeVisible();await page.clock.fastForward(6000);await expect(page.getByText("Действие сохранено.",{exact:true})).toHaveCount(0);
      checks.push(`${width}:errors-persist-success-expires`,`${width}:unrelated-success-preserves-error`,`${width}:resolved-scope-clears-error`,`${width}:same-success-restarts-timer`);
      await page.getByRole("button",{name:"Сообщить успех",exact:true}).click();
      await page.getByRole("button",{name:"Закрыть уведомление",exact:true}).focus();await page.mouse.move(0,0);await page.clock.fastForward(6000);await expect(page.getByText("Действие сохранено.",{exact:true})).toBeVisible();
      await page.getByRole("button",{name:"Открыть форму",exact:true}).focus();await page.clock.fastForward(6000);await expect(page.getByText("Действие сохранено.",{exact:true})).toHaveCount(0);
      await page.getByRole("button",{name:"Важное предупреждение",exact:true}).click();await page.clock.fastForward(12000);await expect(page.getByRole("alert")).toContainText("Проверьте новые правки.");await page.getByRole("button",{name:"Закрыть уведомление",exact:true}).click();
      checks.push(`${width}:focused-success-does-not-disappear`,`${width}:important-warning-persists`);
      await page.setViewportSize({width,height:640});
      for(let index=0;index<6;index++)await page.evaluate(i=>window.notificationFixture.notify(`Очередь ошибок ${i}: проверьте соединение и повторите действие.`,true,`backlog:${i}`),index);
      const newest=page.getByRole("alert").filter({hasText:"Очередь ошибок 5:"});
      await expect(newest).toBeInViewport({ratio:0.8});
      await page.evaluate(()=>{const stack=document.querySelector(".feedback-stack");if(stack)stack.scrollTop=9999;});
      await page.evaluate(()=>window.notificationFixture.notify("Новое важное предупреждение", "warning", "newest-warning"));
      await expect(page.getByRole("alert").filter({hasText:"Новое важное предупреждение"})).toBeInViewport({ratio:0.8});
      await page.screenshot({path:`${output}/${width}-backlog.png`});
      while(await page.getByRole("button",{name:"Закрыть уведомление",exact:true}).count())await page.getByRole("button",{name:"Закрыть уведомление",exact:true}).first().click();
      await page.setViewportSize({width,height:900});checks.push(`${width}:new-important-alert-visible-above-backlog`);
      await page.getByRole("button",{name:"Открыть форму",exact:true}).click();const form=page.getByRole("dialog",{name:"Форма",exact:true});
      await form.getByRole("button",{name:"Сообщить ошибку",exact:true}).click();await expect(form.getByRole("alert")).toBeVisible();
      await form.getByRole("button",{name:"Вложенная форма",exact:true}).click();const nested=page.getByRole("dialog",{name:"Вложенная форма",exact:true});await expect(nested.getByRole("alert")).toBeVisible();
      const close=nested.getByRole("button",{name:"Закрыть уведомление",exact:true});await close.focus();await page.keyboard.press("Enter");await expect(nested.getByRole("alert")).toHaveCount(0);
      await nested.getByRole("button",{name:"Сообщить ошибку",exact:true}).click();await page.screenshot({path:`${output}/${width}-nested-error.png`});
      await page.keyboard.press("Escape");await expect(form.getByRole("alert")).toBeVisible();await page.keyboard.press("Escape");await expect(page.getByRole("alert")).toBeVisible();
      await page.getByRole("button",{name:"Закрыть уведомление",exact:true}).click();checks.push(`${width}:active-modal-host-and-keyboard-dismiss`);
      await page.getByRole("button",{name:"Подключить OpenRouter",exact:true}).click();await page.getByLabel("API-ключ OpenRouter",{exact:true}).fill("synthetic-key");await page.getByRole("button",{name:"Сохранить подключения",exact:true}).click();
      await expect(page.getByText("Подключения сохранены.",{exact:true})).toBeVisible();await page.clock.fastForward(6000);await expect(page.getByText("Подключения сохранены.",{exact:true})).toHaveCount(0);await expect(page.getByText("Подключён",{exact:true})).toBeVisible();
      checks.push(`${width}:inline-success-expires-status-remains`);
      await page.goto(base+'/?pollinations=connected&keep=1#text-provider');await expect(page.getByText("Аккаунт Pollinations подключён",{exact:true})).toBeVisible();await page.getByRole("button",{name:"Открыть форму",exact:true}).focus();await page.clock.fastForward(6000);await expect(page.getByText("Аккаунт Pollinations подключён",{exact:true})).toHaveCount(0);await expect(page.getByRole("button",{name:"Открыть форму",exact:true})).toBeFocused();expect(new URL(page.url()).search).toBe('?keep=1');
      await page.goto(base+'/?pollinations=failed');await expect(page.getByRole("alert")).toContainText("Подключение Pollinations не завершено");await page.clock.fastForward(12000);await expect(page.getByRole("alert")).toBeVisible();
      checks.push(`${width}:oauth-success-expires-without-stealing-focus`,`${width}:oauth-failure-persists`);
      await page.evaluate("window.oldNotificationNotify=window.notificationFixture.notify");profile="fixture-other-owner";await page.evaluate("window.notificationFixture.refresh()");await expect(page.getByTestId("owner")).toHaveText("fixture-other-owner");await page.evaluate("window.oldNotificationNotify('Late private failure',true)");await expect(page.getByText("Late private failure",{exact:true})).toHaveCount(0);
      checks.push(`${width}:old-owner-cannot-publish-after-profile-change`);
      await page.goto(base);await page.getByRole("button",{name:"Загрузить резюме с ошибкой",exact:true}).click();await expect(page.getByRole("alert")).toContainText("Резюме временно недоступно");await page.getByRole("button",{name:"Открыть другое резюме",exact:true}).click();await expect(page.getByRole("heading",{name:"Другое резюме",exact:true})).toBeVisible();await expect(page.getByText("Резюме временно недоступно",{exact:true})).toHaveCount(0);
      checks.push(`${width}:resolved-recap-clears-old-error`);
      await page.getByRole("button",{name:"Создать историю",exact:true}).click();
      const creator=page.getByRole("dialog",{name:"Новая история",exact:true});
      await creator.getByRole("button",{name:"Заполнить пустые поля",exact:true}).click();
      await expect(creator.getByRole("alert")).toBeInViewport();
      await page.screenshot({path:`${output}/${width}-creator-error.png`});
      await page.keyboard.press("Escape");checks.push(`${width}:creator-action-error-visible-without-scrolling`);
      await page.close();
    }
    expect(errors).toEqual([]);await writeFile(output+'/result.json',JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({checks:checks.length,errors}));
  } finally {await browser.close();await new Promise<void>(r=>server.close(()=>r()));}
}
void main().catch(e=>{console.error(e);process.exitCode=1});
