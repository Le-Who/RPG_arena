/** Actual gallery with isolated HTTP/image fixtures; no database or provider calls. */
import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { launchFixtureBrowser } from "./lib/launch-fixture-browser";

async function main() {
  const output = resolve("output/playwright/visual-style");
  await mkdir(output, { recursive: true });
  const bundle = await build({
    stdin: { contents: `
      import React,{useState} from "react";import {createRoot} from "react-dom/client";
      import {VisualGallery} from "./src/components/visual-gallery";
      function Fixture(){const [sessionId,setSessionId]=useState("first");return <>
        <button type="button" onClick={()=>setSessionId("second")}>Другая кампания</button>
        <VisualGallery sessionId={sessionId} isOwner={!location.pathname.endsWith("viewer")} npcs={[{key:"friend",name:"Друг"}]} currentLocationId="garden" lastTurn={3}/>
      </>;}createRoot(document.getElementById("root")).render(<Fixture/>);
    `, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, outfile: "fixture.js", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "gallery-link-fixture", setup(build) {
      build.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'import React from "react";export default function Link({children,...props}){return <a {...props}>{children}</a>}', loader: "tsx", resolveDir: process.cwd() }));
    } }],
  });
  const css = (await Promise.all(["globals", "theatre", "life"].map(name => readFile(`src/app/${name}.css`, "utf8")))).join("\n").replace('@import "tailwindcss";', "");
  const html = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><body><main id="root" style="max-width:420px;margin:auto;padding:12px"></main><script src="/fixture.js"></script></body></html>';
  const server = createServer((req, res) => { res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : req.url === "/fixture.css" ? "text/css" : "text/html"); res.end(req.url === "/fixture.js" ? bundle.outputFiles[0].text : req.url === "/fixture.css" ? css : html); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await launchFixtureBrowser(server, () => chromium.launch());
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=", "base64");
  const checks: string[] = [], errors: string[] = [];
  try {
    for (const width of [320, 390, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
      page.on("pageerror", error => errors.push(error.message));
      const writes: Array<{ session: string; body: Record<string, unknown> }> = [], renders: string[] = [];
      let holdCreate = false;
      let releaseCreate: (() => void) | undefined;
      await page.route("**/api/**", async route => {
        const request = route.request(), url = new URL(request.url());
        const match = /^\/api\/sessions\/(first|second)\/visuals(?:\/stored-image)?$/.exec(url.pathname);
        if (!match) throw Error(`Unexpected API ${url.pathname}`);
        if (url.pathname.endsWith("/stored-image")) {
          renders.push(url.search);
          await route.fulfill({ contentType: "image/png", body: png });
          return;
        }
        if (request.method() === "POST") {
          writes.push({ session: match[1], body: request.postDataJSON() });
          if (holdCreate) await new Promise<void>(done => { releaseCreate = done; });
        }
        await route.fulfill({ json: {
          visuals: [{ id: "stored-image", kind: "scene", subjectKey: "scene:1", turnNumber: 1, caption: "Ранее созданная сцена", provider: "openai", model: "synthetic", seed: 1, status: "failed", error: "Сервис не ответил", width: 320, height: 180, accountSource: "personal" }],
          identities: [], config: { enabled: true, authenticated: true, provider: "openai", accountSource: "personal", availableAccounts: { application: false, personal: true }, model: "synthetic", dailyLimit: 10 },
        } });
      });
      await page.goto(`${base}/owner`);
      const styleDetails = page.locator("details").filter({ has: page.locator("summary", { hasText: "Стиль иллюстраций" }) });
      const summary = styleDetails.locator("summary");
      const style = page.getByRole("textbox", { name: "Свой стиль", exact: true });
      await expect(summary).toBeVisible();
      await expect(style).toBeHidden();
      await summary.focus(); await page.keyboard.press("Enter");
      await expect(style).toBeVisible();
      await expect(styleDetails).toContainText("По тону и сеттингу истории");
      await expect(style).toHaveValue("");
      await expect(style).toHaveAttribute("maxlength", "400");
      const scene = page.getByRole("button", { name: "Сцена хода 3", exact: true });
      await scene.focus(); await page.keyboard.press("Enter");
      await expect.poll(() => writes.length).toBe(1);
      expect(writes[0]).toEqual({ session: "first", body: { kind: "scene", turnNumber: 3 } });
      await expect(scene).toBeEnabled();
      checks.push(`${width}:keyboard-open-and-empty-style-uses-story-default`);

      await style.fill("  Ироничная акварель, мягкие цвета  ");
      holdCreate = true;
      await scene.click();
      await expect.poll(() => writes.length).toBe(2);
      await expect(scene).toBeDisabled();
      await expect(style).toBeEnabled();
      await style.fill("Тёплая книжная иллюстрация");
      expect(writes[1]).toEqual({ session: "first", body: { kind: "scene", turnNumber: 3, styleOverride: "Ироничная акварель, мягкие цвета" } });
      holdCreate = false; releaseCreate?.();
      await expect(scene).toBeEnabled();
      await expect(style).toHaveValue("Тёплая книжная иллюстрация");
      checks.push(`${width}:in-flight-request-captures-style-and-preserves-new-draft`);

      await page.getByRole("button", { name: "Это место", exact: true }).click();
      await expect.poll(() => writes.length).toBe(3);
      expect(writes[2]).toEqual({ session: "first", body: { kind: "location", subject: "garden", styleOverride: "Тёплая книжная иллюстрация" } });
      await expect(scene).toBeEnabled();
      await page.getByRole("combobox", { name: "Чей портрет", exact: true }).selectOption("npc:friend");
      await page.getByRole("button", { name: "Портрет", exact: true }).click();
      await expect.poll(() => writes.length).toBe(4);
      expect(writes[3]).toEqual({ session: "first", body: { kind: "portrait", subject: "npc:friend", styleOverride: "Тёплая книжная иллюстрация" } });
      await expect(scene).toBeEnabled();
      checks.push(`${width}:location-and-portrait-send-style-with-correct-subject`);

      const retry = page.getByRole("button", { name: "Повторить создание", exact: true });
      await retry.focus(); await page.keyboard.press("Enter");
      await expect(page.getByRole("img", { name: "Ранее созданная сцена", exact: true })).toBeVisible();
      await expect.poll(() => renders.length).toBe(1);
      expect(renders).toEqual(["?retry=1&n=1"]);
      expect(writes).toHaveLength(4);
      checks.push(`${width}:retry-keeps-original-record-without-create-post`);

      await style.fill(" ");
      await scene.click();
      await expect.poll(() => writes.length).toBe(5);
      expect(writes[4]).toEqual({ session: "first", body: { kind: "scene", turnNumber: 3 } });
      await expect(scene).toBeEnabled();
      await style.fill("я".repeat(401));
      await expect(style).toHaveValue("я".repeat(400));
      await style.fill("Стиль только первой кампании");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${output}/${width}-owner.png`, fullPage: true });
      checks.push(`${width}:clearing-style-restores-auto-and-input-is-bounded`);

      await page.getByRole("button", { name: "Другая кампания", exact: true }).click();
      await expect(style).toHaveValue("");
      await scene.click();
      await expect.poll(() => writes.length).toBe(6);
      expect(writes[5]).toEqual({ session: "second", body: { kind: "scene", turnNumber: 3 } });
      checks.push(`${width}:style-does-not-cross-campaign-boundary`);

      await page.goto(`${base}/viewer`);
      await expect(page.getByText("Владелец ещё не создал иллюстрацию", { exact: true })).toBeVisible();
      await expect(summary).toHaveCount(0);
      await expect(style).toHaveCount(0);
      await expect(scene).toHaveCount(0);
      expect(writes).toHaveLength(6);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${output}/${width}-reader.png`, fullPage: true });
      checks.push(`${width}:reader-has-no-style-editor-or-generation-controls`);
      await page.close();
    }
    expect(errors).toEqual([]);
    await writeFile(`${output}/result.json`, JSON.stringify({ checks, errors, scope: "Actual gallery; synthetic HTTP/images only" }, null, 2));
    console.log(`Visual style browser checks passed: ${checks.length}`);
  } finally { await browser.close(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
