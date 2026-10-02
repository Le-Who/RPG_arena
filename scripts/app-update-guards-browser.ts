/** Isolated production React fixture; no real database, identity or provider. */
import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

async function main() {
  const output = resolve("output/playwright/app-update-guards");
  await mkdir(output, { recursive: true });
  const bundle = await build({ stdin: { contents: `
    import React,{useState,useRef,useEffect} from "react";
    import {createRoot} from "react-dom/client";
    import {AppUpdateProvider,useAppUpdateGuard} from "./src/components/app-update";
    import {useTurnRequest} from "./src/components/use-turn-request";
    import {saveUpdateDraft,takeUpdateDraftWhenSafe} from "./src/lib/update-draft";
    function Room(){
      const [text,setText]=useState("Черновик «Ключ»");
      const busy=useRef(false);
      const restored=useRef(false);
      const turn=useTurnRequest("fixture",async()=>{});
      useEffect(()=>{
        if(restored.current||!turn.recoveryReady||turn.pending||turn.busy)return;
        const draft=takeUpdateDraftWhenSafe(sessionStorage,"profile","fixture",turn.isUpdateSafe());
        if(draft)setText(draft.action);
        restored.current=true;
      },[turn.recoveryReady,turn.pending,turn.busy,turn.isUpdateSafe]);
      useAppUpdateGuard("shell",{blocked:()=>null});
      const updates=useAppUpdateGuard("play",{blocked:()=>busy.current||!turn.isUpdateSafe()?"Восстанавливаем ход":null,prepare:()=>saveUpdateDraft(sessionStorage,{profileId:"profile",campaignId:"fixture",action:text,itemBindings:[{id:"key",name:"Ключ"}]})});
      return <><h1>Комната истории</h1><div className="gx-composer"><textarea aria-label="Действие" value={text} onChange={e=>setText(e.target.value)}/></div><button onClick={()=>{if(!updates?.isReloading()){busy.current=true;document.title="turn-started"}}}>Начать ход</button><button onClick={()=>busy.current=true}>Внешний ход</button><button onClick={()=>{turn.dismiss();busy.current=false}}>Завершить восстановление</button></>;
    }
    createRoot(document.getElementById("root")).render(<AppUpdateProvider><Room/></AppUpdateProvider>);
  `, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_CHRONICLE_BUILD_ID": '"fixture-old"' }, tsconfig: "tsconfig.json" });
  const css = (await Promise.all(["globals", "pwa"].map(name => readFile(`src/app/${name}.css`, "utf8")))).join("\n").replace('@import "tailwindcss";', "");
  const html = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><body><main id="root"></main><script src="/fixture.js"></script></body></html>';
  const server = createServer((req, res) => { res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : req.url === "/fixture.css" ? "text/css" : "text/html"); res.end(req.url === "/fixture.js" ? bundle.outputFiles[0].text : req.url === "/fixture.css" ? css : html); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/play/fixture`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    let hold: Promise<void> | null = null;
    let requests = 0;
    await page.route("**/api/version", async route => { requests++; if (hold) await hold; await route.fulfill({ json: { buildId: "fixture-new" } }); });
    await page.route("**/api/sessions/**", async route => route.fulfill({ json: { status: "failed", stage: "failed" } }));
    let navigations = 0;
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations++; });
    await page.goto(base);
    const update = page.getByRole("button", { name: "Обновить приложение", exact: true });
    await expect(update).toBeVisible();
    await page.screenshot({ path: `${output}/desktop.png` });
    await update.focus(); await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Позже" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(update).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    expect(requests).toBe(1);
    await page.reload(); await expect(update).toBeVisible();
    await page.context().setOffline(true);
    await update.click();
    await expect(page.getByRole("status")).toContainText("Нет связи");
    await page.context().setOffline(false);
    const beforeStorage = navigations;
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error("Storage denied"); }; });
    await update.click();
    await expect(page.getByRole("status")).toContainText("Storage denied");
    expect(navigations).toBe(beforeStorage);
    await expect(page.getByRole("textbox", { name: "Действие" })).toHaveValue("Черновик «Ключ»");
    await page.reload(); await expect(update).toBeVisible();
    await page.evaluate(() => {
      sessionStorage.setItem("chronicle:pending:fixture", JSON.stringify({id:"pending-1",sessionId:"fixture",action:"Оглядеться",custom:true,expectedTurn:1}));
      sessionStorage.setItem("chronicle:update-draft:v1", JSON.stringify({profileId:"profile",campaignId:"fixture",action:"Сохранённый черновик «Ключ»",itemBindings:[{id:"key",name:"Ключ"}],savedAt:Date.now()}));
    });
    await page.reload(); await expect(update).toBeVisible();
    const beforePending = navigations;
    await update.click(); await expect(page.getByRole("status")).toContainText("Восстанавливаем ход");
    expect(navigations).toBe(beforePending);
    expect(await page.evaluate(() => sessionStorage.getItem("chronicle:update-draft:v1"))).not.toBeNull();
    await page.getByRole("button", {name:"Завершить восстановление"}).click();
    await expect(page.getByRole("textbox", {name:"Действие"})).toHaveValue("Сохранённый черновик «Ключ»");
    expect(await page.evaluate(() => sessionStorage.getItem("chronicle:update-draft:v1"))).toBeNull();
    let release!: () => void;
    hold = new Promise<void>(resolve => { release = resolve; });
    await update.click();
    await expect(page.getByRole("button", { name: "Проверяем…" })).toBeDisabled();
    await page.getByRole("button", { name: "Начать ход", exact: true }).click();
    expect(await page.title()).not.toBe("turn-started");
    await page.getByRole("button", { name: "Внешний ход" }).click();
    release(); hold = null;
    await expect(page.getByRole("status")).toContainText("Восстанавливаем ход");
    expect(navigations).toBe(beforePending);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${output}/mobile.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Завершить восстановление" }).click();
    await update.click();
    await expect.poll(() => navigations).toBe(beforePending + 1);
    await expect(page.getByRole("textbox", {name:"Действие"})).toHaveValue("Сохранённый черновик «Ключ»");
    expect(errors).toEqual([]);
    await writeFile(`${output}/result.json`, JSON.stringify({ checks: ["defer", "focus-throttle", "offline", "storage-denied-no-reload", "pending-recovery", "pending-preserves-reload-draft", "draft-restored-after-recovery", "turn-start-lock", "final-synchronous-guard", "keyboard", "mobile-no-overflow"], errors }, null, 2));
    console.log(`App update guard Chromium checks passed: ${output}`);
  } finally { await browser.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
