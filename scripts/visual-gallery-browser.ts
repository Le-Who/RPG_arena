/** Production React fixture with synthetic API/image responses; no database or provider access. */
import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";
import sharp from "sharp";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";

async function main() {
  const output = "output/playwright/visual-gallery";
  await mkdir(output, { recursive: true });
  const bundle = await build({
    stdin: { contents: 'import React from "react"; import {createRoot} from "react-dom/client"; import {VisualGallery} from "./src/components/visual-gallery"; createRoot(document.getElementById("root")).render(<VisualGallery sessionId="fixture" isOwner={!location.pathname.endsWith("/viewer")} npcs={[]} currentLocationId={null} lastTurn={1}/>);', resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"production"' },
  });
  const css = (await Promise.all(["globals", "life"].map(name => readFile(`src/app/${name}.css`, "utf8")))).join("\n").replace('@import "tailwindcss";', "");
  const html = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><body><main id="root" style="max-width:420px;margin:auto"></main><script src="/fixture.js"></script></body></html>';
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : req.url === "/fixture.css" ? "text/css" : "text/html");
    res.end(req.url === "/fixture.js" ? bundle.outputFiles[0].text : req.url === "/fixture.css" ? css : html);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: "#ffffff" } }).png().toBuffer();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    let authenticated = true;
    let enabled = true;
    let status = "failed";
    const attempts: { retry: string | null; number: string | null }[] = [];
    await page.route("**/api/sessions/fixture/visuals", route => route.fulfill({ json: {
      visuals: [{ id: "failed-image", kind: "scene", subjectKey: "scene:1", turnNumber: 1, caption: "Чай в кафе", provider: "fixture", model: "synthetic", seed: 1, status, error: "Сервис не ответил", width: 320, height: 180 }],
      identities: [], config: { enabled, authenticated, provider: "fixture", model: "synthetic", dailyLimit: 10 },
    } }));
    await page.route("**/api/sessions/fixture/visuals/failed-image*", route => {
      const url = new URL(route.request().url());
      attempts.push({ retry: url.searchParams.get("retry"), number: url.searchParams.get("n") });
      return attempts.length === 1
        ? route.fulfill({ status: 502, contentType: "application/json", body: '{"error":"synthetic unavailable"}' })
        : route.fulfill({ status: 200, contentType: "image/png", body: png });
    });
    await page.goto(base + "/owner");
    const retry = page.getByRole("button", { name: "Повторить создание", exact: true });
    await expect(retry).toBeVisible();
    expect(attempts).toEqual([]);
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => attempts.length, { timeout: 3000 }).toBe(1);
    await expect(retry).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await retry.click();
    await expect(page.getByRole("img", { name: "Чай в кафе", exact: true })).toBeVisible();
    await expect.poll(() => page.getByRole("img", { name: "Чай в кафе", exact: true }).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
    expect(attempts).toEqual([{ retry: "1", number: "1" }, { retry: "1", number: "2" }]);
    await expect(retry).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: `${output}/owner-mobile.png`, fullPage: true });

    await page.goto(base + "/viewer");
    await expect(page.getByText("Владелец ещё не создал иллюстрацию", { exact: true })).toBeVisible();
    await expect(retry).toHaveCount(0);
    await expect(page.getByRole("img")).toHaveCount(0);
    expect(attempts).toHaveLength(2);
    authenticated = false;
    await page.goto(base + "/unconfigured");
    await expect(page.getByText("Создание иллюстраций пока недоступно", { exact: true })).toBeVisible();
    await expect(retry).toHaveCount(0);
    expect(attempts).toHaveLength(2);
    authenticated = true;
    enabled = false;
    await page.goto(base + "/disabled-failed");
    await expect(page.getByText("Визуализация отключена администратором.", { exact: true })).toBeVisible();
    await expect(retry).toHaveCount(0);
    await expect(page.getByRole("img")).toHaveCount(0);
    expect(attempts).toHaveLength(2);
    status = "pending";
    await page.goto(base + "/disabled-pending");
    await expect(page.getByText("Создание иллюстраций пока недоступно", { exact: true })).toBeVisible();
    await expect(page.getByRole("img")).toHaveCount(0);
    expect(attempts).toHaveLength(2);
    status = "ready";
    await page.goto(base + "/disabled-ready");
    await expect.poll(() => page.getByRole("img", { name: "Чай в кафе", exact: true }).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
    expect(attempts).toEqual([{ retry: "1", number: "1" }, { retry: "1", number: "2" }, { retry: null, number: null }]);
    expect(errors).toEqual([]);
    await writeFile(`${output}/result.json`, JSON.stringify({ checks: ["stored-failure-does-not-auto-retry", "keyboard-retry", "failure-can-retry-again", "loaded-real-png", "mobile-no-overflow", "viewer-cannot-generate", "unconfigured-cannot-retry", "disabled-no-retry", "disabled-no-pending-generation", "disabled-keeps-saved-images-readable"], attempts, errors }, null, 2));
    console.log(`Visual gallery Chromium checks passed: ${output}`);
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
