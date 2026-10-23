/** Real client components with synthetic HTTP; no Next server, database, .env or providers. */
import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { mockSession, mockSessionId, mockSnapshot } from "./ui-mock";

const deferred = () => { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; };

async function main() {
  const output = resolve("output/playwright/client-audit");
  await mkdir(output, { recursive: true });
  const bundle = await build({
    stdin: { contents: `
      import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
      import {StoryRecords} from './src/components/story-records';import {VisualGallery} from './src/components/visual-gallery';
      import {EntityActions} from './src/components/entity-actions';
      import {mockSession,mockSnapshot,settings} from './scripts/ui-mock';import {FixtureContext} from './app-shell';
      function Fixture(){const [removed,setRemoved]=useState(false);return <FixtureContext.Provider value={{sessions:removed?[{...mockSession,id:'other',title:'Другая история'}]:[mockSession,{...mockSession,id:'other',title:'Другая история'}],settings:{...settings,keysCount:1,embeddingsEnabled:true},loading:false,newStory:()=>{},notify:()=>{}}}>
        {location.pathname==='/records'?<><button onClick={()=>setRemoved(true)}>Обновить кампании</button><StoryRecords mode="memory"/></>:location.pathname==='/actions'?<EntityActions kind="item" refId={mockSnapshot.inventory[0].id} name="Карта побережья" state={{currentLocation:mockSession.worldState.currentLocation,inventory:mockSnapshot.inventory,npcs:mockSnapshot.npcs,locations:mockSnapshot.locations,sceneObjects:mockSnapshot.sceneObjects}} onPick={()=>{}}/>:<VisualGallery sessionId="fixture" isOwner={true} npcs={[]} currentLocationId={null} lastTurn={1}/>}</FixtureContext.Provider>}
      createRoot(document.getElementById('root')).render(<Fixture/>);
    `, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "audit-fixture", setup(builder) {
      builder.onResolve({ filter: /(?:^|\/)app-shell$/ }, () => ({ path: "app", namespace: "fixture" }));
      builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path === "app" ? 'import {createContext,useContext} from "react";export const FixtureContext=createContext(null);export const useApp=()=>useContext(FixtureContext);' : 'import React from "react";export default function Link(props){return <a {...props}/>}', loader: "tsx", resolveDir: process.cwd() }));
    } }],
  });
  const css = (await Promise.all(["globals", "pages", "shell", "theatre", "life", "dialogs"].map(name => readFile(`src/app/${name}.css`, "utf8")))).join("\n").replace('@import "tailwindcss";', "");
  const html = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><body><main id="root" style="max-width:1200px;margin:auto;padding:16px"></main><script src="/fixture.js"></script></body></html>';
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/fixture.js" ? "text/javascript" : request.url === "/fixture.css" ? "text/css" : "text/html; charset=utf-8");
    response.end(request.url === "/fixture.js" ? bundle.outputFiles[0].text : request.url === "/fixture.css" ? css : html);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch().catch(async error => { await new Promise<void>(done => server.close(() => done())); throw error; });
  const checks: string[] = [];
  try {
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/api/**", route => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith("/memory/search")) return route.fulfill({ json: { results: [{ ...mockSnapshot.memories[0], title: "Результат первой кампании" }], ms: 1 } });
        if (path === `/api/sessions/${mockSessionId}`) return route.fulfill({ json: mockSnapshot });
        if (path === "/api/sessions/other") return route.fulfill({ json: { ...mockSnapshot, session: { ...mockSession, id: "other", title: "Другая история" }, memories: [{ ...mockSnapshot.memories[0], id: "other-memory", sessionId: "other", title: "Память другой кампании" }] } });
        throw Error(`Unexpected request ${path}`);
      });
      if (process.env.CLIENT_AUDIT_ONLY !== "gallery") {
        await page.goto(`${base}/records`);
        await expect(page.getByRole("heading", { name: "Печать Хранителей", exact: true })).toBeVisible();
        const input = page.getByRole("textbox", { name: "Поиск по истории" });
        await input.fill("печать"); await input.press("Enter");
        await expect(page.getByRole("heading", { name: "Результат первой кампании", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Обновить кампании", exact: true }).focus(); await page.keyboard.press("Enter");
        await expect(page.getByRole("combobox", { name: "Выбрать кампанию" })).toHaveValue("other");
        await expect(page.getByRole("heading", { name: "Память другой кампании", exact: true })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Результат первой кампании", exact: true })).toHaveCount(0);
        await expect(input).toHaveValue("");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: `${output}/records-${viewport.width}.png`, fullPage: true });
        checks.push(`${viewport.width}:automatic-campaign-fallback-clears-search`);
      }
      if (process.env.CLIENT_AUDIT_ONLY !== "records") {
        let calls = 0;
        const stale = deferred();
        const visual = (id: string) => ({ id, kind: "scene", subjectKey: "scene:1", turnNumber: 1, caption: id === "first" ? "Первая иллюстрация" : "Вторая иллюстрация", provider: "pollinations", model: "synthetic", seed: 1, status: "failed", error: "Сервис недоступен", width: 320, height: 180 });
        const gallery = (ids: string[]) => ({ visuals: ids.map(visual), identities: [], config: { enabled: false, authenticated: false, provider: "pollinations", model: "synthetic", dailyLimit: 10 } });
        await page.route("**/api/sessions/fixture/visuals/*", route => route.fulfill({ json: { ok: true } }));
        await page.route("**/api/sessions/fixture/visuals", async route => {
          calls++;
          if (calls === 1) return route.fulfill({ json: gallery(["first", "second"]) });
          if (calls === 2) { await stale.promise; return route.fulfill({ json: gallery(["second"]) }); }
          return route.fulfill({ json: gallery([]) });
        });
        try {
          await page.goto(`${base}/gallery`);
          const remove = page.getByRole("button", { name: "Удалить изображение", exact: true });
          await expect(remove).toHaveCount(2); await remove.first().focus(); await page.keyboard.press("Enter");
          await expect.poll(() => calls).toBe(2);
          await remove.last().click(); await expect(page.getByText("Пока нет иллюстраций.", { exact: true })).toBeVisible();
          const finished = page.waitForResponse("**/api/sessions/fixture/visuals"); stale.release(); await (await finished).finished();
          await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
          await expect(page.getByText("Пока нет иллюстраций.", { exact: true })).toBeVisible();
          await expect(page.getByText("Вторая иллюстрация", { exact: true })).toHaveCount(0);
          await page.getByRole("button", { name: "Справка: Образы истории", exact: true }).focus(); await page.keyboard.press("Enter");
          await expect(page.getByRole("dialog", { name: "Образы истории", exact: true })).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(page.getByRole("button", { name: "Справка: Образы истории", exact: true })).toBeFocused();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
          await page.screenshot({ path: `${output}/gallery-${viewport.width}.png`, fullPage: true });
          checks.push(`${viewport.width}:latest-gallery-request-wins`, `${viewport.width}:gallery-keyboard-help-focus`);
        } finally { stale.release(); }
      }
      await page.goto(`${base}/actions`);
      const trigger = page.getByRole("button", { name: "Действия: Карта побережья", exact: true });
      await trigger.focus(); await page.keyboard.press("Enter");
      await page.keyboard.press("Tab");
      await expect(page.getByRole("menuitem", { name: "Осмотреть", exact: true })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await page.screenshot({ path: `${output}/actions-${viewport.width}.png`, fullPage: true });
      checks.push(`${viewport.width}:entity-menu-escape-restores-focus`);
      expect(errors).toEqual([]);
      await page.close();
    }
    await writeFile(`${output}/result.json`, JSON.stringify({ checks, scope: "Real StoryRecords/VisualGallery; synthetic app context, Next Link and HTTP; no DB/providers" }, null, 2));
    console.log(`PASS client audit: ${checks.length} checks; ${output}`);
  } finally { await browser.close(); await new Promise<void>(done => server.close(() => done())); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
