/** Real turn hook in an isolated browser; no database, provider credentials or Next server. */
import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { mockSnapshot } from "./ui-mock";

async function main() {
  const output = resolve("output/playwright/turn-request-lifecycle");
  await mkdir(output, { recursive: true });
  const bundle = await build({ stdin: { contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {useTurnRequest} from './src/components/use-turn-request';
    import {CampaignCopyButton} from './src/components/campaign-copy-button';
    import {CheckpointDialog} from './src/components/checkpoint-dialog';
    import {StoryCreator} from './src/components/story-creator';
    import {CampaignImport} from './src/components/campaign-import';
    import {useApp} from './app-shell';
    window.commits=[];window.navigations=[];window.transportAborted=false;
    const originalFetch=window.fetch;
    window.fetch=(url,init)=>{
      if(String(url).endsWith('/act')) init.signal.addEventListener('abort',()=>{window.transportAborted=true},{once:true});
      return originalFetch(url,init);
    };
    function Turn(){const turn=useTurnRequest('fixture-campaign',async result=>{window.commits.push(result.requestId)});
      return <><button disabled={!turn.recoveryReady||turn.busy} onClick={()=>void turn.send('Поговорить с другом',true,1)}>Отправить</button>
      <output aria-label="Сохранённый запрос">{turn.pending?.id||''}</output></>}
    function Fixture(){const [shown,setShown]=useState(true);window.unmountFixture=()=>setShown(false);
      return <><button onClick={()=>setShown(!shown)}>{shown?'Покинуть историю':'Открыть историю'}</button>{shown&&(location.pathname==='/copy'?<CampaignCopyButton sessionId="fixture-campaign"/>:location.pathname==='/checkpoint'?<CheckpointDialog session={${JSON.stringify(mockSnapshot.session)}} onClose={()=>{}}/>:location.pathname==='/import'?<CampaignImport/>:location.pathname==='/creator'?<StoryCreator initialMode="preset" onClose={()=>{}} onCreated={ownerId=>useApp().refresh(ownerId)} live={false}/>:<Turn/>)}</>}
    createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>);
  `, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"development"' }, plugins: [{ name: "fixture-environment", setup(builder) {
    builder.onResolve({ filter: /^next\/(navigation|link)$|^\.\/app-shell$/ }, args => ({ path: args.path, namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path === "./app-shell" ? 'export const useApp=()=>({loading:false,identity:{kind:"account",profileId:"fixture-owner"},refresh:async expected=>{await Promise.resolve();if(location.search.includes("origin-change")){window.unmountFixture();window.refreshFinished=true;return expected==="new-owner"}if(location.search.includes("identity-change")){window.unmountFixture();window.refreshFinished=true;return false}return true},notify:()=>{}})' : args.path === "next/link" ? 'import React from "react";export default function Link(props){return <a {...props}/>}' : 'export const useRouter=()=>({push:url=>window.navigations.push(url)})', loader: "tsx", resolveDir: process.cwd() }));
  } }] });
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : "text/html; charset=utf-8");
    res.end(req.url === "/fixture.js" ? bundle.outputFiles[0].text : '<!doctype html><html lang="ru"><meta name="viewport" content="width=device-width,initial-scale=1"><body><main id="root"></main><script src="/fixture.js"></script></body></html>');
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const browser = await chromium.launch();
  const reports: unknown[] = [];
  try {
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      let finish!: () => void;
      const responseGate = new Promise<void>(done => { finish = done; });
      let submitted: { requestId: string } | undefined;
      await page.route("**/api/**", async route => {
        if (route.request().method() === "POST") {
          submitted = route.request().postDataJSON();
          await responseGate;
          await route.fulfill({ json: { ok: true, requestId: submitted!.requestId, turnNumber: 2, narration: "Друг улыбается.", choices: [] } }).catch(() => {});
        } else await route.fulfill({ status: 404, json: { code: "NOT_FOUND" } });
      });
      await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
      await page.getByRole("button", { name: "Отправить", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => submitted?.requestId).toBeTruthy();
      await page.getByRole("button", { name: "Покинуть историю", exact: true }).click();
      finish();
      await expect.poll(() => page.evaluate(() => (window as unknown as { transportAborted: boolean }).transportAborted)).toBe(true);
      expect(await page.evaluate(() => (window as unknown as { commits: string[] }).commits)).toEqual([]);
      const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem("chronicle:pending:fixture-campaign")!));
      expect(saved.requestId).toBeUndefined();
      expect(saved.id).toBe(submitted!.requestId);
      await page.getByRole("button", { name: "Открыть историю", exact: true }).click();
      await expect(page.getByLabel("Сохранённый запрос")).toHaveText(submitted!.requestId);
      expect(errors).toEqual([]);
      await page.screenshot({ path: `${output}/${viewport.width}-recovered.png` });
      reports.push({ viewport, pendingIdRetained: true, lateCommitSuppressed: true, transportAborted: true, keyboardSend: true, errors });
      await page.route("**/api/sessions/fixture-campaign/act", route => route.fulfill({ json: { ok: true, requestId: submitted!.requestId, turnNumber: 2, narration: "Друг улыбается.", choices: [] } }));
      await page.getByRole("button", { name: "Отправить", exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as unknown as { commits: string[] }).commits)).toEqual([submitted!.requestId]);
      expect(await page.evaluate(() => sessionStorage.getItem("chronicle:pending:fixture-campaign"))).toBeNull();
      // The reader can change profile or leave a shared campaign while its copy is being created.
      let finishCopy!: () => void;
      const copyGate = new Promise<void>(done => { finishCopy = done; });
      let copyStarted = false;
      await page.route("**/api/sessions/fixture-campaign/copy", async route => {
        copyStarted = true;
        await copyGate;
        await route.fulfill({ json: { session: { id: "private-copy", ownerId: "fixture-owner" } } });
      });
      await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/copy`);
      await page.getByRole("button", { name: "Продолжить в своей копии", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => copyStarted).toBe(true);
      await page.getByRole("button", { name: "Покинуть историю", exact: true }).click();
      const response = page.waitForResponse("**/api/sessions/fixture-campaign/copy");
      finishCopy();
      await (await response).finished();
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      expect(await page.evaluate(() => (window as unknown as { navigations: string[] }).navigations)).toEqual([]);
      expect(errors).toEqual([]);
      reports.push({ viewport, lateCopyNavigationSuppressed: true, errors });
      await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/copy`);
      await page.getByRole("button", { name: "Продолжить в своей копии", exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as unknown as { navigations: string[] }).navigations)).toEqual(["/play/private-copy"]);
      await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/copy?origin-change`);
      await page.getByRole("button", { name: "Продолжить в своей копии", exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as unknown as { refreshFinished: boolean }).refreshFinished)).toBe(true);
      expect(await page.evaluate(() => (window as unknown as { navigations: string[] }).navigations), "copy: identity changed inside refresh").toEqual([]);
      reports.push({ viewport, flow: "copy", refreshIdentityChangeSuppressed: true });
      for (const flow of ["checkpoint", "creator", "import"]) {
        let release!: () => void;
        let started = false;
        const gate = new Promise<void>(done => { release = done; });
        await page.route("**/api/**", async route => {
          if (route.request().method() === "GET") return route.fulfill({ json: { checkpoints: [{ id: "saved-point", title: "Встреча в саду", turnNumber: 3, createdAt: "2026-10-20T12:00:00.000Z", branches: [], summary: { location: "Сад", memories: 0, items: 0, pendingFacts: 0 } }] } });
          started = true;
          await gate;
          await route.fulfill({ json: { session: { id: "new-story", ownerId: "fixture-owner" } } });
        });
        await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/${flow}`);
        // Initial passive dialog effects move focus, including StrictMode's remount.
        if (flow !== "import") await expect(page.getByRole("dialog"), `${flow}: initial modal focus at ${viewport.width}px`).toBeFocused();
        if (flow === "checkpoint") await page.getByRole("button", { name: "Другой путь", exact: true }).click();
        if (flow === "import") {
          await page.getByRole("button", { name: "Импорт кампании", exact: true }).click();
          await expect(page.getByRole("dialog"), `${flow}: initial modal focus at ${viewport.width}px`).toBeFocused();
          // Keep the first read slow on every viewport: setInputFiles does not wait
          // for CampaignImport's asynchronous file.text() and its enabled button.
          await page.evaluate(() => {
            const read = File.prototype.text;
            File.prototype.text = async function () {
              File.prototype.text = read;
              const result = await read.call(this);
              await new Promise(done => setTimeout(done, 1000));
              return result;
            };
          });
          await page.getByLabel("JSON-файл · до 4 МиБ").setInputFiles({ name: "story.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ format: "chronicle-campaign" })) });
        }
        const submit = page.getByRole("button", { name: flow === "checkpoint" ? "Создать независимую ветку" : flow === "import" ? "Импортировать" : "Начать историю" });
        try {
          await expect(submit, `${flow}: submit ready at ${viewport.width}px`).toBeEnabled();
          await submit.focus();
          await expect(submit, `${flow}: keyboard focus at ${viewport.width}px`).toBeFocused();
          await page.keyboard.press("Enter");
          await expect.poll(() => started, `${flow}: keyboard POST at ${viewport.width}px`).toBe(true);
        } catch (error) {
          const activeElement = await page.evaluate(() => document.activeElement?.outerHTML);
          await page.screenshot({ path: `${output}/${viewport.width}-${flow}-keyboard-failure.png` });
          await writeFile(`${output}/${viewport.width}-${flow}-keyboard-failure.json`, JSON.stringify({ flow, viewport, url: page.url(), started, enabled: await submit.isEnabled(), activeElement, errors }, null, 2));
          throw error;
        }
        // Simulate the containing private workspace being replaced by an identity change.
        await page.evaluate(() => (window as unknown as { unmountFixture: () => void }).unmountFixture());
        await expect(page.getByRole("dialog")).toHaveCount(0);
        const completed = page.waitForResponse(response => response.request().method() === "POST");
        release(); await (await completed).finished();
        await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
        expect(await page.evaluate(() => (window as unknown as { navigations: string[] }).navigations)).toEqual([]);
        expect(errors).toEqual([]);
        reports.push({ viewport, flow, staleNavigationSuppressed: true, errors });
        await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/${flow}`);
        if (flow === "checkpoint") await page.getByRole("button", { name: "Другой путь", exact: true }).click();
        if (flow === "import") { await page.getByRole("button", { name: "Импорт кампании", exact: true }).click(); await page.getByLabel("JSON-файл · до 4 МиБ").setInputFiles({ name: "story.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ format: "chronicle-campaign" })) }); }
        await page.getByRole("button", { name: flow === "checkpoint" ? "Создать независимую ветку" : flow === "import" ? "Импортировать" : "Начать историю" }).click();
        await expect.poll(() => page.evaluate(() => (window as unknown as { navigations: string[] }).navigations)).toEqual(["/play/new-story"]);
        await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/${flow}?identity-change`);
        if (flow === "checkpoint") await page.getByRole("button", { name: "Другой путь", exact: true }).click();
        if (flow === "import") { await page.getByRole("button", { name: "Импорт кампании", exact: true }).click(); await page.getByLabel("JSON-файл · до 4 МиБ").setInputFiles({ name: "story.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ format: "chronicle-campaign" })) }); }
        await page.getByRole("button", { name: flow === "checkpoint" ? "Создать независимую ветку" : flow === "import" ? "Импортировать" : "Начать историю" }).click();
        await expect.poll(() => page.evaluate(() => (window as unknown as { refreshFinished: boolean }).refreshFinished)).toBe(true);
        expect(await page.evaluate(() => (window as unknown as { navigations: string[] }).navigations), `${flow}: identity changed inside refresh`).toEqual([]);
        reports.push({ viewport, flow, refreshIdentityChangeSuppressed: true });
      }
      await page.close();
    }
    await writeFile(`${output}/report.json`, JSON.stringify(reports, null, 2));
    console.log(JSON.stringify(reports));
  } finally { await browser.close(); await new Promise<void>(done => server.close(() => done())); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
