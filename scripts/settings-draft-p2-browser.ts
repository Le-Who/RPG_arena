/** Real settings components in isolated Chromium; literal API contracts, no Next server/DB/provider/.env. */
import { chromium, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Settings } from "../src/lib/ui-data";

const initialSettings: Settings = {
  keysMasked: [], keysCount: 0, envKeysCount: 0, useLiveAI: false, canUseLive: false,
  textProvider: "gemini", textModel: "", routingProfile: "balanced",
  narrationModel: "gemini-3.5-flash-lite", customActionModel: "gemini-3.8-flash",
  compactionModel: "gemini-3.8-flash", fastTaskModel: "gemini-3.5-flash-lite",
  keysSharedProject: true, dailyEmbeddingLimit: 500, dailyFlashLimit: 20, dailyLiteLimit: 500,
  enforceLimits: true, embeddingsEnabled: true, embeddingModel: "gemini-embedding-2",
  embeddingDims: 768, semanticExtractionEnabled: true,
};
const emptyProvider = { provider: "gemini", model: "", openrouterConfigured: false, pollinationsConfigured: false, useLiveAI: false };
function gate() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; }

async function main() {
  const output = resolve("output/playwright/settings-draft-p2");
  await mkdir(output, { recursive: true });
  const appStub = `
    import React,{createContext,useContext,useState,useCallback} from "react";
    const Context=createContext(null);
    export function useApp(){return useContext(Context)}
    export function FixtureApp({children}){
      const [settings,setSettings]=useState(${JSON.stringify(initialSettings)});
      const [notices,setNotices]=useState([]);
      const refresh=useCallback(async()=>{const r=await fetch('/api/settings');setSettings(await r.json());return true},[]);
      const acceptSettings=useCallback(value=>setSettings(value),[]);
      const notify=useCallback((message,error=false)=>setNotices(old=>[...old,{message,error}]),[]);
      const value={settings,workspace:{displayName:'Гость',favorites:[],reading:{textScale:'normal',measure:'normal',theme:'midnight',motion:'reduced'}},identity:location.search.includes('account=1')?{kind:'account',profileId:'fixture-account',account:{login:'fixture_user'},isAdmin:false,pendingGuestCampaigns:0}:null,administration:false,loading:false,hasOpenDraft:false,refresh,acceptSettings,notify,resolveNotification:()=>{},updateReading:async()=>{}};
      return <Context.Provider value={value}>{children}<aside aria-label="Уведомления фикстуры">{notices.map((n,i)=><p key={i} data-error={n.error}>{n.message}</p>)}</aside></Context.Provider>
    }`;
  const bundle = await build({ stdin: { contents: `
    import React,{useCallback,useState} from "react";import {createRoot} from "react-dom/client";
    import {FixtureApp} from "fixture:app";import {TextProviderSettings} from "./src/components/text-provider-settings";
    import {SettingsPanel} from "./src/components/settings-panel"; import {DeveloperSettings} from "./src/components/developer-settings";
    function ProviderFixture(){const [dirty,setDirty]=useState(false);const [saved,setSaved]=useState([]);const ready=useCallback(()=>{},[]);return <><TextProviderSettings onDirtyChange={setDirty} onSaveReady={ready} onSaved={value=>setSaved(old=>[...old,value])}/><output aria-label="Черновик">{dirty?'изменён':'сохранён'}</output><output aria-label="События сохранения">{JSON.stringify(saved)}</output></>}
    createRoot(document.getElementById('root')).render(location.pathname==='/provider'?<ProviderFixture/>:<FixtureApp><nav aria-label="Переходы фикстуры"><a href="/">Главная</a><a href="/overview">Обзор</a><a href="/campaigns">Мои кампании</a></nav>{location.pathname==='/developer'?<DeveloperSettings returnLabel="Назад к настройкам" onClose={()=>{document.body.dataset.closed='yes'}}/>:<SettingsPanel {...(location.pathname==='/standalone'?{}:{onClose:()=>{document.body.dataset.closed='yes'},returnLabel:'Вернуться в историю'})}/>}</FixtureApp>);
  `, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, outfile: "fixture.js", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "settings-environment", setup(build) {
    build.onResolve({ filter: /(?:^|\/)app-shell$|^fixture:app$/ }, () => ({ path: "app-shell", namespace: "fixture" }));
    build.onResolve({ filter: /^next\/(navigation|link)$/ }, args => ({ path: args.path, namespace: "fixture" }));
    // NarrativeSettings uses only this server module's client-safe catalog. Crypto never runs here.
    build.onResolve({ filter: /^node:crypto$/ }, () => ({ path: "crypto", namespace: "fixture" }));
    build.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path === "app-shell" ? appStub : args.path === "crypto" ? 'export function createHash(){throw new Error("Server crypto must not execute in settings fixture")}' : args.path === "next/navigation" ? 'const router={push:url=>{document.body.dataset.navigation=url}};export function useRouter(){return router}' : 'import React from "react";export default function Link({href,children,...props}){return <a href={href} {...props}>{children}</a>}', loader: "tsx", resolveDir: process.cwd() }));
  } }] });
  const css = (await Promise.all(["globals", "pages", "preferences", "dialogs"].map(name => readFile(`src/app/${name}.css`, "utf8")))).join("\n").replace('@import "tailwindcss";', "");
  const html = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><body><main id="root" style="max-width:1200px;margin:auto;padding:16px"></main><script src="/fixture.js"></script></body></html>';
  const server = createServer((req, res) => { res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : req.url === "/fixture.css" ? "text/css" : "text/html"); res.end(req.url === "/fixture.js" ? bundle.outputFiles[0].text : req.url === "/fixture.css" ? css : html); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch();
  const checks: string[] = [], errors: string[] = [];
  let active: Page | undefined;
  const watch = (page: Page) => page.on("pageerror", error => errors.push(error.message));
  try {
    for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "mobile", width: 390, height: 844 }, { name: "narrow", width: 320, height: 720 }]) {
      const page = await browser.newPage({ viewport, reducedMotion: "reduce" }); active = page; watch(page);
      let providerState: Record<string, unknown> = emptyProvider;
      const providerWrites: unknown[] = [];
      const unexpected: string[] = [];
      await page.route("**/api/**", async route => {
        const url = new URL(route.request().url());
        let body: unknown = {}, status = 200;
        if (url.pathname === "/api/settings/pollinations/connect") body = { available: false };
        else if (url.pathname === "/api/settings/pollinations/models" || url.pathname === "/api/settings/visual-provider/models") body = { models: [{ id: "openai", name: "Модель фикстуры", structuredOutput: true, streaming: true }] };
        else if (url.pathname === "/api/settings/text-provider/models") body = { models: [{ id: url.searchParams.get("provider") === "openrouter" ? "vendor/draft" : "openai", name: "Модель фикстуры", structuredOutput: true, streaming: true }] };
        else if (url.pathname === "/api/settings/text-provider") {
          if (route.request().method() === "GET") body = providerState;
          else {
            providerWrites.push(route.request().postDataJSON());
            if (providerWrites.length === 1) { status = 503; body = { code: "UNAVAILABLE", message: "Сохранение временно недоступно" }; }
            else if (providerWrites.length === 2) { status = 409; body = { code: "STALE_SETTINGS", message: "Настройки изменились в другой вкладке" }; }
            else if (providerWrites.length === 3) body = providerState = { provider: "openrouter", model: "vendor/canonical", openrouterConfigured: true, pollinationsConfigured: false, useLiveAI: false };
            else { unexpected.push("extra provider write"); status = 500; }
          }
        } else { unexpected.push(url.pathname); status = 500; }
        await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      });
      await page.goto(`${base}/provider`);
      await page.getByRole("button", { name: "Изменить рассказчика", exact: true }).click();
      const provider = page.getByRole("combobox", { name: "Провайдер рассказчика" });
      await expect(provider).toHaveValue("gemini");
      await provider.focus(); await page.keyboard.press("Home"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
      await expect(provider).toHaveValue("openrouter");
      const model = page.getByLabel("Идентификатор модели рассказчика", { exact: true });
      await page.getByText("Дополнительные настройки модели", { exact: true }).click();
      await model.fill(" vendor/draft ");
      await page.getByRole("switch", { name: "Живой рассказчик" }).click();
      const save = page.getByRole("button", { name: "Сохранить рассказчика", exact: true });
      for (const message of ["Сохранение временно недоступно", "Настройки изменились в другой вкладке"]) {
        await save.focus(); await page.keyboard.press("Enter");
        await expect(page.getByRole("alert")).toHaveText(message);
        await expect(model).toHaveValue(" vendor/draft ");
        await expect(provider).toHaveValue("openrouter"); await expect(page.getByRole("switch", { name: "Живой рассказчик" })).toHaveAttribute("aria-checked", "true");
        await expect(page.getByLabel("Черновик", { exact: true })).toHaveText("изменён");
        await expect(page.getByLabel("События сохранения")).toHaveText("[]");
        await expect(page.getByText("Настройки рассказчика сохранены.", { exact: true })).toHaveCount(0);
        await page.screenshot({ path: `${output}/${viewport.name}-${providerWrites.length === 1 ? "provider-failed" : "provider-conflict"}.png`, fullPage: true });
      }
      await save.click();
      await expect(model).toHaveValue("vendor/canonical");
      await expect(page.getByRole("switch", { name: "Живой рассказчик" })).toHaveAttribute("aria-checked", "false");
      await expect(page.getByLabel("Черновик", { exact: true })).toHaveText("сохранён");
      await expect(page.getByLabel("События сохранения")).toHaveText("[false]");
      const expectedRouter = { provider: "openrouter", model: "vendor/draft", useLiveAI: true };
      expect(providerWrites).toEqual([expectedRouter, expectedRouter, expectedRouter]);
      await page.reload(); await page.getByRole("button", { name: "Изменить рассказчика", exact: true }).click();
      await expect(provider).toHaveValue("openrouter");
      await page.getByText("Дополнительные настройки модели", { exact: true }).click();
      await expect(model).toHaveValue("vendor/canonical");
      expect(providerWrites).toEqual([expectedRouter, expectedRouter, expectedRouter]);
      expect(unexpected).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${output}/${viewport.name}-provider-saved.png`, fullPage: true });
      checks.push(`${viewport.name}:provider-503-retains`, `${viewport.name}:provider-409-retains`, `${viewport.name}:provider-keyboard-retry-canonical`, `${viewport.name}:provider-reload`, `${viewport.name}:provider-no-overflow`);
      console.log(`${viewport.name} TextProviderSettings: 5 checks passed, 3 exact role-only POST payloads`);
      await page.close();

      const panel = await browser.newPage({ viewport, reducedMotion: "reduce" }); active = panel; watch(panel);
      const firstSave = gate();
      let settingsState = { ...initialSettings };
      const settingsWrites: Record<string, unknown>[] = [];
      await panel.route("**/api/**", async route => {
        const url = new URL(route.request().url()); let body: unknown; let status = 200;
        if (url.pathname === "/api/settings/provider-connections") body = { geminiConfigured: false, openrouterConfigured: false, pollinationsConfigured: false };
        else if (url.pathname === "/api/settings/text-provider") body = emptyProvider;
        else if (url.pathname === "/api/settings/visual-provider") body = { accountSource: "application", model: "fixture/image", applicationModel: "fixture/image", applicationConfigured: false, pollinationsConfigured: false };
        else if (url.pathname === "/api/settings/pollinations/connect") body = { available: false };
        else if (url.pathname === "/api/settings/narrative") body = { enabled: false, active: false, provider: "openrouter", configured: false, maskedKey: null, model: "typesafe/jev-1.13", credentialSource: "none", administratorAvailable: false };
        else if (url.pathname === "/api/tokens/stats") body = { today: { totalReq: 0, totalTokens: 0, errors: 0, embeddingReq: 0 }, quotas: { note: "Фикстура" } };
        else if (url.pathname === "/api/settings") {
          if (route.request().method() === "GET") body = settingsState;
          else {
            settingsWrites.push(route.request().postDataJSON());
            if (settingsWrites.length === 1) {
              await firstSave.promise;
              settingsState = { ...initialSettings, dailyFlashLimit: 30, keysCount: 1, keysMasked: ["••••draft-a"] };
              body = { ok: true, ...settingsState };
            } else if (settingsWrites.length === 2) { status = 503; body = { code: "UNAVAILABLE", message: "Общие настройки временно недоступны" }; }
            else if (settingsWrites.length === 3) {
              settingsState = { ...initialSettings, dailyFlashLimit: 41, keysCount: 2, keysMasked: ["••••draft-a", "••••draft-b"] };
              body = { ok: true, ...settingsState };
            } else { unexpected.push("extra settings write"); status = 500; body = {}; }
          }
        } else { unexpected.push(url.pathname); status = 500; body = {}; }
        await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      });
      await panel.goto(`${base}/panel`);
      await expect(panel.getByRole("button", { name: "Изменить рассказчика" })).toBeVisible();
      await panel.getByText("Дополнительные настройки ИИ", { exact: true }).click();
      await panel.getByText("Лимиты обращений к ИИ", { exact: true }).click();
      const limit = panel.getByRole("spinbutton", { name: "Flash · на модель в сутки", exact: true });
      const gemini = panel.locator('input[aria-label="API-ключ Gemini"]:visible');
      await limit.fill("30"); await gemini.fill("synthetic-gemini-draft-a");
      const saveAll = panel.getByRole("button", { name: "Сохранить настройки", exact: true });
      await panel.getByRole("button", { name: "Вернуться в историю", exact: true }).click();
      await expect(panel.getByRole("dialog", { name: "Есть несохранённые изменения", exact: true })).toBeVisible();
      await expect(panel.getByRole("dialog", { name: "Есть несохранённые изменения", exact: true })).toBeFocused();
      await panel.getByRole("button", { name: "Сохранить и выйти", exact: true }).focus(); await panel.keyboard.press("Enter");
      await expect.poll(() => settingsWrites.length).toBe(1);
      await expect(saveAll).toBeDisabled();
      await panel.getByRole("button", { name: "Продолжить редактирование", exact: true }).click();
      await limit.fill("41"); await gemini.fill("synthetic-gemini-draft-b");
      await panel.screenshot({ path: `${output}/${viewport.name}-panel-newer-draft.png`, fullPage: true });
      firstSave.open(); await expect(saveAll).toBeEnabled();
      await expect(limit).toHaveValue("41"); await expect(gemini).toHaveValue("synthetic-gemini-draft-b");
      await expect(panel.getByText("••••draft-a", { exact: true })).toBeVisible();
      await expect(panel.getByText("Сохранён отправленный вариант. Новые изменения ещё не сохранены.", { exact: true })).toBeVisible();
      await expect(panel.getByText("Настройки сохранены.", { exact: true })).toHaveCount(0);
      await expect(panel.getByRole("dialog", { name: "Есть несохранённые изменения", exact: true })).toHaveCount(0);
      expect(await panel.getAttribute("body", "data-closed")).toBeNull();
      await saveAll.click();
      await expect(panel.getByText("Общие настройки временно недоступны", { exact: true })).toBeVisible();
      await expect(limit).toHaveValue("41"); await expect(gemini).toHaveValue("synthetic-gemini-draft-b");
      await saveAll.focus(); await panel.keyboard.press("Enter");
      await expect(panel.getByText("••••draft-b", { exact: true })).toBeVisible();
      await expect(limit).toHaveValue("41"); await expect(gemini).toHaveValue("");
      const generalSettings = Object.fromEntries(Object.entries(initialSettings).filter(([key]) => key !== "useLiveAI"));
      const submittedA = { ...generalSettings, dailyFlashLimit: 30, keysText: "synthetic-gemini-draft-a", append: true };
      const submittedB = { ...generalSettings, dailyFlashLimit: 41, keysCount: 1, keysMasked: ["••••draft-a"], keysText: "synthetic-gemini-draft-b", append: true };
      expect(settingsWrites).toEqual([submittedA, submittedB, submittedB]);
      expect(unexpected).toEqual([]);
      expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await panel.screenshot({ path: `${output}/${viewport.name}-panel-saved.png`, fullPage: true });
      checks.push(`${viewport.name}:panel-stale-success-retains`, `${viewport.name}:panel-dirty-close-guard`, `${viewport.name}:panel-503-retains`, `${viewport.name}:panel-keyboard-retry-canonical`, `${viewport.name}:panel-no-overflow`);
      console.log(`${viewport.name} SettingsPanel: 5 checks passed, 3 exact POST payloads`);
      await panel.close();

      const crossSection = await browser.newPage({ viewport, reducedMotion: "reduce" }); active = crossSection; watch(crossSection);
      const imageSave = gate(); let imageSaveHeld = false;
      let crossNarrator = { provider: "pollinations", model: "vendor/text-a", openrouterConfigured: false, pollinationsConfigured: true, useLiveAI: false };
      let crossImages = { accountSource: "application", model: "vendor/image-a", applicationModel: "vendor/shared", applicationConfigured: true, pollinationsConfigured: true };
      await crossSection.route("**/api/**", async route => {
        const url = new URL(route.request().url()); let body: unknown;
        if (url.pathname === "/api/settings/provider-connections") body = { geminiConfigured: false, openrouterConfigured: false, pollinationsConfigured: true };
        else if (url.pathname === "/api/settings/text-provider") {
          if (route.request().method() === "POST") crossNarrator = { ...crossNarrator, ...route.request().postDataJSON() };
          body = crossNarrator;
        } else if (url.pathname === "/api/settings/visual-provider") {
          if (route.request().method() === "POST") { imageSaveHeld = true; const submitted = route.request().postDataJSON(); await imageSave.promise; crossImages = { ...crossImages, ...submitted }; }
          body = crossImages;
        } else if (url.pathname === "/api/settings/pollinations/connect") body = { available: false };
        else if (url.pathname === "/api/settings/pollinations/models" || url.pathname === "/api/settings/visual-provider/models") body = { models: ["a", "b"].map(suffix => ({ id: `vendor/${url.searchParams.get("kind")}-${suffix}`, name: `Модель ${suffix}`, structuredOutput: true, streaming: true })) };
        else if (url.pathname === "/api/settings/narrative") body = { enabled: false, active: false, provider: "openrouter", configured: false, maskedKey: null, model: "typesafe/jev-1.13", credentialSource: "none", administratorAvailable: false };
        else if (url.pathname === "/api/tokens/stats") body = { today: { totalReq: 0, totalTokens: 0, errors: 0, embeddingReq: 0 }, quotas: { note: "Фикстура" } };
        else if (url.pathname === "/api/settings" && route.request().method() === "GET") body = { ...initialSettings, textProvider: crossNarrator.provider, textModel: crossNarrator.model };
        else throw new Error(`Unexpected cross-section request: ${route.request().method()} ${url.pathname}`);
        await route.fulfill({ json: body });
      });
      await crossSection.goto(`${base}/panel`);
      await crossSection.getByRole("button", { name: "Изменить рассказчика" }).click();
      const crossModel = crossSection.locator('#text-provider input[type="radio"][value="vendor/text-a"]');
      await expect(crossModel).toBeChecked();
      await crossSection.locator('#text-provider input[type="radio"][value="vendor/text-b"]').check();
      await crossSection.getByRole("button", { name: "Изменить иллюстрации" }).click();
      await crossSection.getByRole("combobox", { name: "Аккаунт для иллюстраций", exact: true }).selectOption("personal");
      await crossSection.getByRole("button", { name: "Вернуться в историю", exact: true }).click();
      await crossSection.getByRole("button", { name: "Сохранить и выйти", exact: true }).click();
      await expect.poll(() => imageSaveHeld).toBe(true);
      expect(crossNarrator.model).toBe("vendor/text-b");
      await crossSection.getByRole("button", { name: "Продолжить редактирование", exact: true }).click();
      await crossSection.getByRole("button", { name: "Изменить рассказчика" }).click();
      await crossModel.check();
      await crossSection.screenshot({ path: `${output}/${viewport.name}-cross-section-newer-draft.png`, fullPage: true });
      imageSave.open();
      await expect(crossSection.getByRole("button", { name: "Сохранить настройки", exact: true })).toBeEnabled();
      await expect(crossModel).toBeChecked();
      expect(await crossSection.getAttribute("body", "data-closed"), "Late narrator edits while the image save is pending must keep the settings open").toBeNull();
      await expect(crossSection.getByRole("dialog", { name: "Есть несохранённые изменения", exact: true })).toHaveCount(0);
      checks.push(`${viewport.name}:cross-section-late-edit-keeps-save-and-return-open`);
      await crossSection.goto(`${base}/panel?keep=fixture&pollinations=cancelled#text-provider`);
      await crossSection.getByText("Лимиты обращений к ИИ", { exact: true }).click();
      const historyLimit = crossSection.getByRole("spinbutton", { name: "Flash · на модель в сутки", exact: true });
      await historyLimit.fill("37");
      await expect.poll(() => crossSection.evaluate(() => Boolean(history.state?.chronicleDirtyGuard))).toBe(true);
      const dismissReturn = crossSection.getByRole("button", { name: "Закрыть сообщение Pollinations", exact: true });
      await dismissReturn.focus(); await crossSection.keyboard.press("Enter");
      await expect(crossSection).toHaveURL(`${base}/panel?keep=fixture#text-provider`);
      await crossSection.evaluate(() => history.back());
      await expect(crossSection.getByRole("dialog", { name: "Есть несохранённые изменения", exact: true })).toBeVisible();
      await expect(historyLimit).toHaveValue("37");
      await crossSection.getByRole("button", { name: "Продолжить редактирование", exact: true }).click();
      await expect(historyLimit).toHaveValue("37");
      expect(await crossSection.getAttribute("body", "data-closed")).toBeNull();
      await crossSection.evaluate(() => history.back());
      await expect(crossSection.getByRole("dialog", { name: "Есть несохранённые изменения", exact: true })).toBeVisible();
      await crossSection.getByRole("button", { name: "Выйти без сохранения", exact: true }).click();
      await expect(crossSection.locator("body")).toHaveAttribute("data-closed", "yes");
      checks.push(`${viewport.name}:notice-dismiss-keeps-dirty-back-confirmation`);
      await crossSection.close();

      const departure = await browser.newPage({ viewport, reducedMotion: "reduce" }); active = departure; watch(departure);
      const delayed = gate(), developerSave = gate(); let writeStarted = false, developerWriteStarted = false;
      await departure.route("**/api/**", async route => {
        const pathname = new URL(route.request().url()).pathname;
        let body: unknown;
        if (pathname === "/api/settings/provider-connections") body = { geminiConfigured: false, openrouterConfigured: false, pollinationsConfigured: false };
        else if (pathname === "/api/settings/text-provider") body = emptyProvider;
        else if (pathname === "/api/settings/visual-provider") body = { enabled: false, provider: "pollinations", endpoint: null, accountSource: "application", model: "fixture/image", applicationModel: "fixture/image", applicationConfigured: false, pollinationsConfigured: false };
        else if (pathname === "/api/settings/pollinations/connect") body = { available: false };
        else if (pathname === "/api/settings/narrative") body = { enabled: false, active: false, provider: "openrouter", configured: false, maskedKey: null, model: "typesafe/jev-1.13", credentialSource: "none", administratorAvailable: false };
        else if (pathname === "/api/tokens/stats") body = { today: { totalReq: 0, totalTokens: 0, errors: 0, embeddingReq: 0 }, quotas: { note: "Фикстура" } };
        else if (pathname === "/api/developer/typesafe/results") body = { results: [] };
        else if (pathname === "/api/developer/typesafe") {
          if (route.request().method() === "POST") { developerWriteStarted = true; await developerSave.promise; }
          body = { configured: false, storedConfigured: false, maskedKey: null, source: "none", envOverride: false, pilotEnabled: false, model: "jev-1.13.0" };
        }
        else if (pathname === "/api/settings" && route.request().method() === "POST") {
          writeStarted = true; await delayed.promise;
          body = { ...initialSettings, dailyFlashLimit: 31 };
        } else throw Error("Unexpected departure fixture request: " + pathname);
        await route.fulfill({ status: 200, json: body });
      });
      await departure.goto(`${base}/standalone?account=1`);
      await expect(departure.getByRole("heading", { name: "Аккаунт · fixture_user", exact: true })).toBeVisible();
      await expect(departure.getByText("Вы вошли в аккаунт. Приватные истории доступны только вам.", { exact: true })).toHaveCount(0);
      await departure.getByText("Лимиты обращений к ИИ", { exact: true }).click();
      const navLimit = departure.getByRole("spinbutton", { name: "Flash · на модель в сутки", exact: true });
      await navLimit.fill("31");
      const decision = departure.getByRole("dialog", { name: "Есть несохранённые изменения", exact: true });
      for (const destination of ["Обзор", "Мои кампании", "Главная"]) {
        const link = departure.getByRole("link", { name: destination, exact: true });
        await link.click();
        await expect(decision).toBeVisible(); await expect(decision).toBeFocused();
        expect(await decision.evaluate(el => { const b=el.getBoundingClientRect(); return b.left>=0 && b.right<=innerWidth && b.top>=0 && b.bottom<=innerHeight; })).toBe(true);
        expect(await departure.locator("#root").evaluate(el => el instanceof HTMLElement && el.inert)).toBe(true);
        expect(await departure.getAttribute("body", "data-navigation")).toBeNull();
        await departure.screenshot({ path: `${output}/${viewport.name}-departure-dialog.png` });
        await departure.keyboard.press("Escape");
        await expect(decision).toHaveCount(0); await expect(link).toBeFocused(); await expect(navLimit).toHaveValue("31");
      }
      checks.push(`${viewport.name}:every-navigation-attempt-opens-focused-modal`, `${viewport.name}:account-has-no-persistent-success-banner`);
      await departure.getByRole("link", { name: "Главная", exact: true }).click();
      await decision.getByRole("button", { name: "Выйти без сохранения", exact: true }).click();
      await expect(departure.locator("body")).toHaveAttribute("data-navigation", "/");
      await departure.goto(`${base}/panel`);
      await departure.getByText("Лимиты обращений к ИИ", { exact: true }).click();
      await navLimit.fill("31");
      await departure.getByRole("button", { name: "Вернуться в историю", exact: true }).click();
      await decision.getByRole("button", { name: "Сохранить и выйти", exact: true }).click();
      await expect.poll(() => writeStarted).toBe(true);
      await decision.getByRole("button", { name: "Продолжить редактирование", exact: true }).click();
      // No newer edits: the save succeeds, but the cancelled departure must stay cancelled.
      delayed.open();
      await expect(departure.getByText("Настройки сохранены.", { exact: true })).toBeVisible();
      expect(await departure.getAttribute("body", "data-closed")).toBeNull();
      await expect(decision).toHaveCount(0); await expect(navLimit).toHaveValue("31");
      checks.push(`${viewport.name}:discard-uses-requested-destination`, `${viewport.name}:cancel-during-save-never-leaves-after-success`);
      await departure.goto(`${base}/developer`);
      const developerKey = departure.getByLabel("API-ключ TypeSafe", { exact: true });
      await developerKey.fill("synthetic-developer-submitted");
      const developerBack = departure.getByRole("button", { name: "Назад к настройкам", exact: true });
      await developerBack.click(); await expect(decision).toBeFocused();
      await departure.keyboard.press("Escape"); await expect(developerBack).toBeFocused();
      await expect(developerKey).toHaveValue("synthetic-developer-submitted");
      await developerBack.click();
      await decision.getByRole("button", { name: "Сохранить и выйти", exact: true }).click();
      await expect.poll(() => developerWriteStarted).toBe(true);
      await decision.getByRole("button", { name: "Продолжить редактирование", exact: true }).click();
      await developerKey.fill("synthetic-developer-newer");
      developerSave.open();
      await expect(departure.getByText("Настройки TypeSafe сохранены.", { exact: true })).toBeVisible();
      await expect(developerKey).toHaveValue("synthetic-developer-newer");
      expect(await departure.getAttribute("body", "data-closed")).toBeNull();
      await developerBack.click();
      await decision.getByRole("button", { name: "Выйти без сохранения", exact: true }).click();
      await expect(departure.locator("body")).toHaveAttribute("data-closed", "yes");
      checks.push(`${viewport.name}:developer-modal-cancel-preserves-newer-key`, `${viewport.name}:developer-discard-leaves-explicitly`);
      await departure.close();
    }
    expect(errors).toEqual([]);
    await writeFile(`${output}/result.json`, JSON.stringify({ checks, checkCount: checks.length, errors, scope: "actual TextProviderSettings + SettingsPanel; app context, Next navigation/link and unused server crypto stubbed; literal HTTP responses" }, null, 2));
    console.log(`Settings draft Chromium checks passed: ${checks.length}; ${output}`);
  } catch (error) {
    if (active && !active.isClosed()) await active.screenshot({ path: `${output}/failure.png`, fullPage: true });
    await writeFile(`${output}/failure.json`, JSON.stringify({ checks, errors, error: String(error) }, null, 2));
    throw error;
  } finally { await browser.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
