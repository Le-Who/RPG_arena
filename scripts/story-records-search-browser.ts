/** Real StoryRecords with isolated HTTP fixtures; no Next server, database, provider, or .env. */
import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { mockSessionId, mockSnapshot, settings } from "./ui-mock";

async function main() {
  const output = resolve("output/playwright/story-records-search");
  await mkdir(output, { recursive: true });
  const app = `
    import {mockSession,settings} from './scripts/ui-mock';
    export function useApp(){return {sessions:[mockSession],settings:{...settings,keysCount:1,embeddingsEnabled:location.pathname!='/disabled'},newStory:()=>{},notify:()=>{},loading:false}}
  `;
  const bundle = await build({ stdin: { contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {StoryRecords} from './src/components/story-records';
    createRoot(document.getElementById('root')).render(<StoryRecords mode="memory"/>);
  `, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "records-environment", setup(build) {
    build.onResolve({ filter: /(?:^|\/)app-shell$/ }, () => ({ path: "app", namespace: "fixture" }));
    build.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }));
    build.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path === "app" ? app : 'import React from "react";export default function Link({href,children,...props}){return <a href={href} {...props}>{children}</a>}', loader: "tsx", resolveDir: process.cwd() }));
  } }] });
  const css = (await Promise.all(["globals", "pages", "shell"].map(name => readFile(`src/app/${name}.css`, "utf8")))).join("\n").replace('@import "tailwindcss";', "");
  const html = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><body><main id="root" style="max-width:1200px;margin:auto;padding:16px"></main><script src="/fixture.js"></script></body></html>';
  const server = createServer((req, res) => { res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : req.url === "/fixture.css" ? "text/css" : "text/html"); res.end(req.url === "/fixture.js" ? bundle.outputFiles[0].text : req.url === "/fixture.css" ? css : html); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch().catch(async error => { await new Promise<void>(resolve => server.close(() => resolve())); throw error; });
  const errors: string[] = [], checks: string[] = [];
  try {
    for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "mobile", width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
      page.on("pageerror", error => errors.push(error.message));
      let searchCount = 0;
      let releaseSearch: (() => void) | undefined;
      await page.route("**/api/**", async route => {
        const url = new URL(route.request().url());
        if (url.pathname === `/api/sessions/${mockSessionId}`) return route.fulfill({ json: mockSnapshot });
        if (url.pathname === `/api/sessions/${mockSessionId}/memory/search`) {
          searchCount++;
          expect(url.searchParams.get("q")).toBe("несуществующее слово");
          await new Promise<void>(resolve => { releaseSearch = resolve; });
          return route.fulfill({ json: { results: [{ ...mockSnapshot.memories[0], title: "Поздний ответ поиска" }], ms: 1 } });
        }
        throw new Error(`Unexpected request ${route.request().method()} ${url.pathname}`);
      });
      await page.goto(`${base}/disabled`);
      await expect(page.getByRole("heading", { name: "Печать Хранителей", exact: true })).toBeVisible();
      const input = page.getByRole("textbox", { name: "Поиск по истории" });
      await input.fill("несуществующее слово");
      await expect(page.getByRole("button", { name: "Поиск по смыслу", exact: true })).toBeDisabled();
      // Browser event barriers allow fetch initiated by Enter to arrive without arbitrary sleeps.
      await input.press("Enter");
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(searchCount, "Enter must respect disabled embeddings just like the search button").toBe(0);
      await page.screenshot({ path: `${output}/${viewport.name}-disabled-keyboard.png`, fullPage: true });
      checks.push(`${viewport.name}:disabled-keyboard-no-request`);

      await page.goto(`${base}/enabled`);
      await expect(page.getByRole("heading", { name: "Печать Хранителей", exact: true })).toBeVisible();
      await input.fill("несуществующее слово");
      await input.press("Enter");
      await expect.poll(() => searchCount).toBe(1);
      await expect(page.getByRole("button", { name: "Поиск по смыслу", exact: true })).toBeDisabled();
      const reset = page.getByRole("button", { name: "Сбросить поиск", exact: true });
      await reset.focus(); await page.keyboard.press("Enter");
      await expect(input).toHaveValue("");
      await expect(page.getByRole("heading", { name: "Печать Хранителей", exact: true })).toBeVisible();
      const finished = page.waitForResponse(response => response.url().includes("/memory/search"));
      releaseSearch!(); await finished;
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(page.getByText("Записи истории", { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Поздний ответ поиска", exact: true })).toHaveCount(0);
      await expect(page.locator(".memory-card")).toHaveCount(2);
      await expect(page.getByRole("button", { name: "Поиск по смыслу", exact: true })).toBeDisabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: `${output}/${viewport.name}-reset-late-response.png`, fullPage: true });
      checks.push(`${viewport.name}:reset-invalidates-inflight`, `${viewport.name}:reset-keyboard`, `${viewport.name}:no-overflow`);
      await page.close();
    }
    expect(errors).toEqual([]);
    await writeFile(`${output}/result.json`, JSON.stringify({ checks, errors, fixture: { keysCount: 1, baseEmbeddingsEnabled: settings.embeddingsEnabled }, scope: "Real StoryRecords and api-client; app context and Next Link stubbed; synthetic HTTP snapshots/search" }, null, 2));
    console.log(`PASS StoryRecords search: ${checks.length} checks; desktop/mobile keyboard; no page errors; ${output}`);
  } finally { await browser.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
