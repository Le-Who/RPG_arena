/** Settings saves use canonical mutation results; all requests are isolated fixtures. */
import { chromium, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Settings } from "../src/lib/ui-data";

const initial: Settings = {
  keysMasked: [], keysCount: 0, envKeysCount: 0, useLiveAI: false, canUseLive: false,
  textProvider: "gemini", textModel: "", routingProfile: "balanced",
  narrationModel: "gemini-3.5-flash-lite", customActionModel: "gemini-3.8-flash",
  compactionModel: "gemini-3.8-flash", fastTaskModel: "gemini-3.5-flash-lite",
  keysSharedProject: true, dailyEmbeddingLimit: 500, dailyFlashLimit: 20, dailyLiteLimit: 500,
  enforceLimits: true, embeddingsEnabled: true, embeddingModel: "gemini-embedding-2", embeddingDims: 768, semanticExtractionEnabled: true,
};
function gate() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; }
async function main() {
  const output = resolve("output/playwright/settings-latency"); await mkdir(output, { recursive: true });
  const app = `import React,{createContext,useContext,useState,useCallback} from 'react';
    const Context=createContext(null);export function useApp(){return useContext(Context)};
    export function FixtureApp({children}){const [settings,setSettings]=useState(${JSON.stringify(initial)}),[notices,setNotices]=useState([]);
    const refresh=useCallback(async()=>{document.body.dataset.refreshes=String(Number(document.body.dataset.refreshes||0)+1);await fetch('/api/auth/me')},[]);
    const acceptSettings=useCallback((value,profileId)=>{if(profileId==='fixture-owner'){setSettings(value);document.body.dataset.accepted=JSON.stringify(value)}},[]);
    const notify=useCallback(text=>setNotices(old=>[...old,text]),[]);
    return <Context.Provider value={{settings,acceptSettings,refresh,notify,workspace:{id:'fixture-owner',displayName:'Гость',favorites:[],reading:{textScale:'normal',measure:'normal',theme:'midnight',motion:'reduced'}},identity:{kind:'guest',profileId:'fixture-owner'},administration:false,loading:false,updateReading:async()=>{}}}>{children}<aside aria-label='Сообщения'>{notices.map((n,i)=><p key={i}>{n}</p>)}</aside></Context.Provider>}`;
  const bundle = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {FixtureApp} from 'fixture:app';import {SettingsPanel} from './src/components/settings-panel';createRoot(document.getElementById('root')).render(<FixtureApp><SettingsPanel onClose={()=>{document.body.dataset.closed='yes'}}/></FixtureApp>);`, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, outfile: "fixture.js", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "fixtures", setup(b) {
    b.onResolve({ filter: /(?:^|\/)app-shell$|^fixture:app$/ }, () => ({ path: "app", namespace: "fixture" }));
    b.onResolve({ filter: /^next\/(navigation|link)$|^node:crypto$/ }, args => ({ path: args.path, namespace: "fixture" }));
    b.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path === "app" ? app : args.path === "node:crypto" ? 'export function createHash(){throw new Error("Unexpected server crypto")}' : args.path === "next/navigation" ? 'const router={push(){}};export function useRouter(){return router}' : 'import React from "react";export default function Link({href,children,...p}){return <a href={href} {...p}>{children}</a>}', loader: "tsx", resolveDir: process.cwd() }));
  } }] });
  const css = (await Promise.all(["globals", "pages", "preferences", "dialogs"].map(name => readFile(`src/app/${name}.css`, "utf8")))).join("\n").replace('@import "tailwindcss";', "");
  const html = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><body><main id="root" style="max-width:1200px;margin:auto;padding:16px"></main><script src="/fixture.js"></script></body></html>';
  const server = createServer((req, res) => { res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : req.url === "/fixture.css" ? "text/css" : "text/html"); res.end(req.url === "/fixture.js" ? bundle.outputFiles[0].text : req.url === "/fixture.css" ? css : html); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch(); const checks: string[] = [], errors: string[] = []; let active: Page | undefined;
  try {
    for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "mobile", width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport }); active = page; page.on("pageerror", e => errors.push(e.message));
      const writes: Record<string, unknown>[] = [], reads: string[] = []; let state = { ...initial }; let delayed: ReturnType<typeof gate> | null = null; let delayedCanonicalRead: ReturnType<typeof gate> | null = null; let fail = false;
      const providerWrites: Record<string, unknown>[] = [];
      let providerState = { provider: "gemini", model: "", openrouterConfigured: false, pollinationsConfigured: false, useLiveAI: false };
      await page.route("**/api/**", async route => {
        const path = new URL(route.request().url()).pathname; let body: unknown = {}; let status = 200;
        if (path === "/api/auth/me") { await new Promise<void>(() => {}); return; }
        if (path === "/api/settings") {
          if (route.request().method() === "POST") {
            const submitted = route.request().postDataJSON(); writes.push(submitted);
            if (delayed) await delayed.promise;
            if (fail) { status = 503; body = { message: "Сохранение временно недоступно" }; }
            else {
              const keysMasked = submitted.keysText ? [...state.keysMasked, "••••fixture"] : Array.isArray(submitted.removeIndex) ? state.keysMasked.filter((_, index) => !submitted.removeIndex.includes(index)) : state.keysMasked;
              state = { ...state, dailyFlashLimit: submitted.dailyFlashLimit ?? state.dailyFlashLimit, keysCount: keysMasked.length, keysMasked }; body = { ok: true, ...state };
            }
          } else { reads.push(path); body = structuredClone(state); if (delayedCanonicalRead) await delayedCanonicalRead.promise; }
        } else if (path === "/api/settings/text-provider") {
          if (route.request().method() === "POST") {
            const input = route.request().postDataJSON(); providerWrites.push(input);
            providerState = { ...providerState, provider: input.provider, model: input.model, openrouterConfigured: true, useLiveAI: input.useLiveAI };
            state = { ...state, textProvider: "openrouter", textModel: input.model, useLiveAI: input.useLiveAI, canUseLive: input.useLiveAI };
          }
          body = providerState;
        }
        else if (path === "/api/settings/text-provider/models") body = { models: [] };
        else if (path === "/api/settings/narrative") body = { enabled: false, active: false, provider: "openrouter", configured: false, maskedKey: null, model: "jev", credentialSource: "none", administratorAvailable: false };
        else if (path === "/api/tokens/stats") body = { today: { totalReq: 0, totalTokens: 0, errors: 0, embeddingReq: 0 }, quotas: { note: "fixture" } };
        else if (path === "/api/settings/pollinations/connect") body = { available: false };
        else throw new Error(`Unexpected request ${path}`);
        await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      });
      await page.goto(base);
      const save = page.getByRole("button", { name: "Сохранить настройки", exact: true });
      const limit = page.getByText("Flash · на модель в сутки", { exact: true }).locator("..").locator("input");
      const key = page.getByRole("textbox", { name: "API-ключ Gemini", exact: true });
      await expect(page.getByRole("button", { name: "Сохранить рассказчика", exact: true })).toBeVisible();
      await limit.fill("30"); await save.focus(); await page.keyboard.press("Enter");
      await expect(save).toBeEnabled({ timeout: 2000 });
      await expect(page.getByText("Настройки сохранены. Ваш мир готов к новым историям.", { exact: true })).toBeVisible();
      expect(writes).toHaveLength(1); expect(reads).toEqual([]); expect(await page.getAttribute("body", "data-refreshes")).toBeNull();
      expect(JSON.parse((await page.getAttribute("body", "data-accepted"))!)).toMatchObject({ dailyFlashLimit: 30 });
      checks.push(`${viewport.name}:one-post-canonical-no-refresh`);
      delayed = gate(); await limit.fill("31"); await key.fill("synthetic-secret-a"); await save.click(); await expect.poll(() => writes.length).toBe(2);
      await limit.fill("32"); await key.fill("synthetic-secret-b"); delayed.open(); delayed = null;
      await expect(save).toBeEnabled(); await expect(limit).toHaveValue("32"); await expect(key).toHaveValue("synthetic-secret-b");
      await expect(page.getByText("Сохранён отправленный вариант. Новые изменения ещё не сохранены.", { exact: true })).toBeVisible();
      checks.push(`${viewport.name}:newer-draft-survives`);
      fail = true; await save.click(); await expect(save).toBeEnabled(); await expect(page.getByText("Сохранение временно недоступно", { exact: true })).toBeVisible();
      await expect(limit).toHaveValue("32"); await expect(key).toHaveValue("synthetic-secret-b");
      fail = false; await save.focus(); await page.keyboard.press("Enter"); await expect(key).toHaveValue(""); await expect(limit).toHaveValue("32");
      expect(writes[2]).toEqual(writes[3]); expect(reads).toEqual([]); expect(writes).toHaveLength(4);
      checks.push(`${viewport.name}:failure-retry-retains-key`);
      await page.getByRole("combobox", { name: "Провайдер рассказчика" }).selectOption("openrouter");
      await page.getByLabel("Идентификатор модели рассказчика", { exact: true }).fill("vendor/new-model");
      await page.getByLabel("Новый API-ключ OpenRouter", { exact: true }).fill("synthetic-router-secret");
      await page.getByRole("switch", { name: "Живой рассказчик" }).click();
      await save.click(); await expect(save).toBeEnabled();
      expect(writes).toHaveLength(4); expect(providerWrites).toEqual([{ provider: "openrouter", model: "vendor/new-model", useLiveAI: true, apiKey: "synthetic-router-secret" }]);
      expect(reads).toEqual(["/api/settings"]); expect(await page.getAttribute("body", "data-refreshes")).toBeNull();
      expect(JSON.parse((await page.getAttribute("body", "data-accepted"))!)).toMatchObject({ textProvider: "openrouter", textModel: "vendor/new-model", canUseLive: true });
      checks.push(`${viewport.name}:provider-only-one-targeted-read`);
      delayedCanonicalRead = gate();
      const readsBeforeStandalone = reads.length;
      await page.getByLabel("Идентификатор модели рассказчика", { exact: true }).fill("vendor/standalone-model");
      await page.getByRole("button", { name: "Сохранить рассказчика", exact: true }).click();
      await expect.poll(() => reads.length).toBe(readsBeforeStandalone + 1);
      const keysBeforeDelete = state.keysCount;
      await page.getByRole("button", { name: "Удалить ключ 1", exact: true }).click();
      await expect.poll(async () => JSON.parse((await page.getAttribute("body", "data-accepted"))!).keysCount).toBe(keysBeforeDelete - 1);
      delayedCanonicalRead.open(); delayedCanonicalRead = null;
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(JSON.parse((await page.getAttribute("body", "data-accepted"))!).keysCount).toBe(keysBeforeDelete - 1);
      checks.push(`${viewport.name}:standalone-provider-read-cannot-undo-key-removal`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${output}/${viewport.name}-saved.png`, fullPage: true }); await page.close();
    }
    expect(errors).toEqual([]); await writeFile(`${output}/result.json`, JSON.stringify({ checks, errors, scope: "Real SettingsPanel; literal mutation responses; no DB/provider/Next server" }, null, 2));
    console.log(`Settings latency checks passed: ${checks.length}`);
  } catch (error) { if (active && !active.isClosed()) await active.screenshot({ path: `${output}/failure.png`, fullPage: true }); throw error; }
  finally { await browser.close(); await new Promise<void>((r, reject) => server.close(e => e ? reject(e) : r())); }
}
void main().catch(e => { console.error(e); process.exitCode = 1; });
