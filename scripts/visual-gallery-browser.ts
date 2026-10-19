/** Production React fixture with synthetic API/image responses; no database or provider access. */
import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";

async function main() {
  const output = "output/playwright/visual-gallery";
  await mkdir(output, { recursive: true });
  const bundle = await build({
    stdin: { contents: 'import React from "react"; import {createRoot} from "react-dom/client"; import {VisualGallery} from "./src/components/visual-gallery"; createRoot(document.getElementById("root")).render(<VisualGallery sessionId="fixture" isOwner={!location.pathname.endsWith("/viewer")} npcs={[]} currentLocationId={null} lastTurn={1}/>);', resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "gallery-link-fixture", setup(build) {
      build.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'import React from "react"; export default function Link({children,...props}){return <a {...props}>{children}</a>}', loader: "jsx", resolveDir: process.cwd() }));
    } }],
  });
  const css = (await Promise.all(["globals", "theatre", "life"].map(name => readFile(`src/app/${name}.css`, "utf8")))).join("\n").replace('@import "tailwindcss";', "");
  const html = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><body><main id="root" style="max-width:420px;margin:auto"></main><script src="/fixture.js"></script></body></html>';
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : req.url === "/fixture.css" ? "text/css" : "text/html");
    res.end(req.url === "/fixture.js" ? bundle.outputFiles[0].text : req.url === "/fixture.css" ? css : html);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=", "base64");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", error => { errors.push(error.message); console.error(`Gallery browser error: ${error.message}`); });
    let failLoad = true;
    let authenticated = true;
    let enabled = true;
    let status = "failed";
    let accountSource = "application", visualAccountSource = "application", generationBlocked = false;
    let provider = "pollinations", visualProvider = "pollinations";
    let availableAccounts: { application: boolean; personal: boolean } | undefined;
    const attempts: { retry: string | null; number: string | null }[] = [];
    await page.route("**/api/sessions/fixture/visuals", route => failLoad ? route.fulfill({ status: 503, json: { message: "Галерея временно недоступна" } }) : route.fulfill({ json: {
      visuals: [{ id: "failed-image", kind: "scene", subjectKey: "scene:1", turnNumber: 1, caption: "Чай в кафе", provider: visualProvider, model: "synthetic", accountSource: visualAccountSource, generationBlocked, seed: 1, status, error: "Сервис не ответил", width: 320, height: 180 }],
      identities: [], config: { enabled, authenticated, provider, accountSource, availableAccounts, model: "synthetic", dailyLimit: 10 },
    } }));
    await page.route("**/api/sessions/fixture/visuals/failed-image*", route => {
      const url = new URL(route.request().url());
      attempts.push({ retry: url.searchParams.get("retry"), number: url.searchParams.get("n") });
      return attempts.length === 1
        ? route.fulfill({ status: 502, contentType: "application/json", body: '{"error":"synthetic unavailable"}' })
        : route.fulfill({ status: 200, contentType: "image/png", body: png });
    });
    await page.goto(base + "/owner");
    await expect(page.getByRole("alert")).toContainText("Галерея временно недоступна");
    failLoad = false;
    await page.getByRole("button", { name: "Повторить загрузку галереи", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    const help = page.getByRole("button", { name: "Справка: Образы истории", exact: true });
    await help.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Образы истории", exact: true })).toBeVisible();
    await expect(page.getByText("Иллюстрации помогают представить сцену, персонажа или место. Они не меняют события и состояние истории.", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(help).toBeFocused();
    const retry = page.getByRole("button", { name: "Повторить создание", exact: true });
    await expect(retry).toBeVisible();
    expect(attempts).toEqual([]);
    await retry.focus();
    await page.screenshot({ path: `${output}/owner-desktop-retry-focus.png`, fullPage: true });
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
    await expect(page.getByText("Создание иллюстраций выключено. Уже созданные изображения остаются доступны.", { exact: true })).toBeVisible();
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
    enabled = true; status = "failed"; authenticated = false; accountSource = "personal"; availableAccounts = { application: true, personal: false };
    await page.goto(base + "/old-application");
    await expect(retry).toBeVisible();
    await expect(page.getByText(/ваш аккаунт Pollinations, расходуется ваш Pollen/)).toBeVisible();
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const geometry = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, overflowing: Array.from(document.querySelectorAll<HTMLElement>("body *")).flatMap(element => { const rect = element.getBoundingClientRect(); return element.getClientRects().length && (rect.right > innerWidth + 1 || element.scrollWidth > element.clientWidth + 1) ? [{ tag: element.tagName, className: element.className, text: element.textContent?.slice(0, 100), right: rect.right, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }] : []; }) }));
      await writeFile(`${output}/payer-${width}-geometry.json`, JSON.stringify(geometry, null, 2));
      expect(geometry.documentWidth, JSON.stringify(geometry)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: `${output}/payer-${width}.png`, fullPage: true });
      await help.click();
      const helpDialog = page.getByRole("dialog", { name: "Образы истории", exact: true });
      await expect(helpDialog).toBeVisible();
      expect(await helpDialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: `${output}/help-${width}.png`, fullPage: true });
      await page.keyboard.press("Escape");
      await expect(help).toBeFocused();
    }
    await retry.click();
    await expect.poll(() => page.getByRole("img", { name: "Чай в кафе", exact: true }).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
    expect(attempts).toHaveLength(4);
    generationBlocked = true; visualAccountSource = "personal"; availableAccounts.personal = true; authenticated = true;
    await page.goto(base + "/transferred-personal");
    await expect(retry).toHaveCount(0); await expect(page.getByRole("img")).toHaveCount(0); expect(attempts).toHaveLength(4);
    provider = "openrouter"; visualProvider = "pollinations";
    await page.goto(base + "/openrouter");
    await expect(page.getByText("ваш аккаунт OpenRouter, расходуется ваш баланс", { exact: true })).toBeVisible();
    await expect(page.getByText("Личный аккаунт Pollinations · synthetic", { exact: true })).toBeVisible();
    await expect(page.getByText(/описания сцен, людей и мест передаются в OpenRouter/)).toBeVisible();
    authenticated = false;
    await page.goto(base + "/openrouter-unconfigured");
    await expect(page.getByText(/Выбранный аккаунт OpenRouter недоступен/)).toBeVisible();
    expect(attempts).toHaveLength(4);
    expect(errors).toEqual([]);
    await writeFile(`${output}/result.json`, JSON.stringify({ checks: ["initial-load-failure-is-visible-and-retryable", "stored-failure-does-not-auto-retry", "keyboard-retry", "failure-can-retry-again", "loaded-real-png", "mobile-no-overflow", "viewer-cannot-generate", "unconfigured-cannot-retry", "disabled-no-retry", "disabled-no-pending-generation", "disabled-keeps-saved-images-readable", "retry-uses-recorded-payer-availability", "transferred-personal-generation-blocked", "payer-layout-1280-390-320", "help-opens-by-keyboard-and-restores-focus", "openrouter-new-payer-pollinations-recorded-payer", "openrouter-unavailable-shows-service"], attempts, errors, scope: "actual gallery; Next Link stubbed, synthetic HTTP/images" }, null, 2));
    console.log(`Visual gallery Chromium checks passed: ${output}`);
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
