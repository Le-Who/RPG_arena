/** Real connection editor; synthetic HTTP contracts, no Next server, database, or provider calls. */
import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { launchFixtureBrowser } from "./lib/launch-fixture-browser";

const originalMasks = ["one••••1111", "two••••2222", "three••••3333"];
async function main() {
  const output = resolve("output/playwright/service-connections-gemini");
  await mkdir(output, { recursive: true });
  const bundle = await build({ stdin: { contents: `
    import React,{useCallback,useState} from "react";import {createRoot} from "react-dom/client";
    import {ServiceConnections} from "./src/components/service-connections";
    function Fixture(){const [keys,setKeys]=useState(location.search.includes("empty")?[]:${JSON.stringify(originalMasks)});
      const ready=useCallback(()=>{},[]),beforeConnect=useCallback(async()=>true,[]);
      const saved=useCallback(async()=>{const response=await fetch("/api/settings");setKeys((await response.json()).keysMasked)},[]);
      return <ServiceConnections geminiKeys={keys} onDirtyChange={ready} onSaveReady={ready} onSaved={saved} beforeConnect={beforeConnect}/>;}
    createRoot(document.getElementById("root")).render(<Fixture/>);
  `, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, outfile: "fixture.js", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"production"' } });
  const css = (await Promise.all(["globals", "pages", "preferences", "dialogs"].map(name => readFile(`src/app/${name}.css`, "utf8")))).join("\n").replace('@import "tailwindcss";', "");
  const html = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><body><main id="root" style="max-width:1000px;margin:auto;padding:16px"></main><script src="/fixture.js"></script></body></html>';
  const server = createServer((req, res) => { res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : req.url === "/fixture.css" ? "text/css" : "text/html"); res.end(req.url === "/fixture.js" ? bundle.outputFiles[0].text : req.url === "/fixture.css" ? css : html); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await launchFixtureBrowser(server, () => chromium.launch());
  const checks: string[] = [], errors: string[] = [];
  try {
    for (const width of [1280, 390]) {
      for (const scenario of ["valid", "repair", "empty"] as const) {
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
        page.on("pageerror", error => errors.push(error.message));
        let masks = scenario === "empty" ? [] : [...originalMasks], repair = scenario === "repair";
        const writes: Array<{ path: string; body: unknown }> = [];
        await page.route("**/api/**", async route => {
          const path = new URL(route.request().url()).pathname;
          if (path === "/api/settings/pollinations/connect") return route.fulfill({ json: { available: false } });
          if (route.request().method() === "POST") {
            const input = route.request().postDataJSON(); writes.push({ path, body: input });
            if (path === "/api/settings") {
              expect(input).toEqual({ keysText: "synthetic-gemini-added", append: true });
              masks = [...masks, "added••••4444"];
            } else {
              expect(path).toBe("/api/settings/provider-connections");
              expect(input.provider).toBe("gemini");
              expect(Object.keys(input).sort()).toEqual(["apiKey", "provider"]);
              expect(["synthetic-gemini-added", "synthetic-gemini-replacement"]).toContain(input.apiKey);
              masks = [input.apiKey === "synthetic-gemini-added" ? "added••••4444" : "replacement••••5555"]; repair = false;
            }
          }
          await route.fulfill({ json: path === "/api/settings" ? { keysMasked: masks } : { geminiConfigured: masks.length > 0, openrouterConfigured: false, pollinationsConfigured: false, ...(repair ? { credentialIssues: ["gemini"] } : {}) } });
        });
        await page.goto(`${base}/?${scenario}`);
        await page.getByRole("button", { name: scenario === "empty" ? "Подключить Gemini" : scenario === "repair" ? "Заменить ключ Gemini" : "Изменить Gemini", exact: true }).click();
        const input = page.getByLabel("API-ключ Gemini", { exact: true });
        const mode = page.getByRole("combobox", { name: "Сохранить ключ Gemini", exact: true });
        const save = page.getByRole("button", { name: "Сохранить подключения", exact: true });
        if (scenario === "valid") {
          // Exercise the default without touching its mode control: an accidental replacement loses the original three masks.
          await input.fill("synthetic-gemini-added"); await save.click();
          await expect(page.locator(".saved-key code")).toHaveText([...originalMasks, "added••••4444"]);
          await expect(mode).toHaveValue("append");
          expect(writes).toEqual([{ path: "/api/settings", body: { keysText: "synthetic-gemini-added", append: true } }]);
          checks.push(`${width}:default-preserves-three-existing-keys`);
          await mode.selectOption("replace"); await input.fill("synthetic-gemini-replacement"); await save.click();
          await expect(page.locator(".saved-key code")).toHaveText(["replacement••••5555"]);
          await expect(mode).toHaveValue("append");
          expect(writes[1]).toEqual({ path: "/api/settings/provider-connections", body: { provider: "gemini", apiKey: "synthetic-gemini-replacement" } });
          checks.push(`${width}:explicit-replacement-resets-default`);
          await mode.selectOption("replace"); await input.fill("synthetic-cancelled-key");
          await page.getByRole("button", { name: "Отменить изменения подключений", exact: true }).click();
          await expect(input).toHaveValue(""); await expect(mode).toHaveValue("append"); expect(writes).toHaveLength(2);
          checks.push(`${width}:cancel-resets-default-without-writing`);
          await input.fill("synthetic-gemini-added"); await save.click();
          await expect(page.locator(".saved-key code")).toHaveText(["replacement••••5555", "added••••4444"]);
          checks.push(`${width}:next-save-appends-after-replacement-and-cancel`);
        } else {
          if (scenario === "repair") { await expect(mode).toHaveValue("replace"); await expect(mode).toBeDisabled(); }
          await input.fill("synthetic-gemini-replacement"); await save.click();
          await expect(page.locator(".saved-key code")).toHaveText(["replacement••••5555"]);
          await expect(mode).toHaveValue("append"); await expect(mode).toBeEnabled();
          expect(writes).toEqual([{ path: "/api/settings/provider-connections", body: { provider: "gemini", apiKey: "synthetic-gemini-replacement" } }]);
          checks.push(`${width}:${scenario === "repair" ? "unreadable-keys-force-replacement" : "first-key-uses-connection-endpoint"}`);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: `${output}/${width}-${scenario}.png`, fullPage: true });
        await page.close();
      }
    }
    expect(errors).toEqual([]);
    await writeFile(`${output}/result.json`, JSON.stringify({ checks, errors }, null, 2));
    console.log(`Gemini connection browser checks passed: ${checks.length}`);
  } finally { await browser.close(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
