/** Actual settings components; disposable HTTP fixture, synthetic keys and provider responses only. */
import { chromium, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
function gate() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; }

async function main() {
  const output = "output/playwright/pollinations-settings";
  await mkdir(output, { recursive: true });
  const bundle = await build({ stdin: { contents: `
    import React,{useCallback,useState} from 'react';import {createRoot} from 'react-dom/client';
    import {TextProviderSettings} from './src/components/text-provider-settings';import {ImageProviderSettings} from './src/components/image-provider-settings';import {PollinationsConnectionNotice} from './src/components/pollinations-connect';
    function Fixture(){const [textDirty,setTextDirty]=useState(false),[imageDirty,setImageDirty]=useState(false),[revision,setRevision]=useState(0);const ready=useCallback(()=>{},[]),saved=useCallback((live,changed)=>{if(changed)setRevision(x=>x+1)},[]);return <div className="settings-page"><h1 tabIndex={-1}>Настройки</h1><PollinationsConnectionNotice/><div className="settings-main"><TextProviderSettings onDirtyChange={setTextDirty} onSaveReady={ready} onSaved={saved}/><ImageProviderSettings onDirtyChange={setImageDirty} onSaveReady={ready} connectionRevision={revision}/><output aria-label="Черновик иллюстраций">{imageDirty?'изменён':'сохранён'}</output></div></div>};createRoot(document.getElementById('root')).render(<Fixture/>);
  `, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"production"' } });
  const css = (await Promise.all(["globals", "pages", "preferences"].map(name => readFile(`src/app/${name}.css`, "utf8")))).join("\n").replace('@import "tailwindcss";', "");
  const html = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><body><main id="root" style="max-width:1000px;margin:auto"></main><script src="/fixture.js"></script></body></html>';
  const server = createServer((req, res) => { res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : req.url === "/fixture.css" ? "text/css" : "text/html"); res.end(req.url === "/fixture.js" ? bundle.outputFiles[0].text : req.url === "/fixture.css" ? css : html); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch(), checks: string[] = [], errors: string[] = [];
  let active: Page | undefined;
  try {
    for (const viewport of [{ name: "desktop", width: 1280, height: 1000 }, { name: "mobile", width: 390, height: 844 }, { name: "mobile-320", width: 320, height: 844 }]) {
      const page = await browser.newPage({ viewport, reducedMotion: "reduce" }); active = page; page.on("pageerror", error => errors.push(error.message));
      let narrator = { provider: "gemini", model: "", useLiveAI: false, openrouterConfigured: false, pollinationsConfigured: false };
      let images = { accountSource: "application", model: "vendor/image-a", applicationModel: "vendor/shared", applicationConfigured: true, pollinationsConfigured: true };
      const textWrites: unknown[] = [], imageWrites: unknown[] = [];
      let refreshFails = false, denySave = false, connects = 0, failImageLoad = false;
      let connectAvailable = true, failAvailability = false, failConnect = false;
      let holdAvailability: ReturnType<typeof gate> | null = null;
      let availabilityHeld = false;
      let holdMetadata: ReturnType<typeof gate> | null = null, holdText: ReturnType<typeof gate> | null = null;
      let holdNarrator: ReturnType<typeof gate> | null = null;
      let metadataHeld = false, textHeld = false;
      await page.route("**/api/**", async route => {
        const request = route.request(), url = new URL(request.url()); let json: unknown; let status = 200;
        if (url.pathname === "/api/settings/text-provider") {
          if (request.method() === "GET" && holdNarrator) { const waiting = holdNarrator; holdNarrator = null; await waiting.promise; }
          if (request.method() === "POST") { const data = request.postDataJSON(); textWrites.push(data); narrator = { ...narrator, provider: data.provider, model: data.model, useLiveAI: data.useLiveAI, pollinationsConfigured: data.clearKey ? false : narrator.pollinationsConfigured }; images.pollinationsConfigured = narrator.pollinationsConfigured; }
          json = narrator;
        } else if (url.pathname === "/api/settings/visual-provider") {
          if (request.method() === "GET" && failImageLoad) { failImageLoad = false; await route.fulfill({ status: 503, json: { error: "Initial settings unavailable" } }); return; }
          if (request.method() === "GET" && holdMetadata) {
            const waiting = holdMetadata, snapshot = { ...images, pollinationsConfigured: narrator.pollinationsConfigured }; holdMetadata = null; metadataHeld = true;
            await waiting.promise; await route.fulfill({ json: snapshot }); return;
          }
          if (request.method() === "POST") { const data = request.postDataJSON(); imageWrites.push(data); if (denySave) { status = 503; json = { error: "Сохранение иллюстраций временно недоступно" }; } else images = { ...images, ...data }; }
          json ??= { ...images, pollinationsConfigured: narrator.pollinationsConfigured };
        } else if (url.pathname === "/api/settings/pollinations/connect") {
          if (request.method() === "POST") { connects++; status = failConnect ? 503 : 200; json = failConnect ? { error: "Вход временно недоступен. Повторите попытку." } : { url: "https://enter.pollinations.ai/authorize?fixture=1" }; }
          else {
            if (holdAvailability) { const waiting = holdAvailability; holdAvailability = null; availabilityHeld = true; await waiting.promise; }
            status = failAvailability ? 503 : 200; json = failAvailability ? { error: "Synthetic unavailable" } : { available: connectAvailable };
          }
        } else if (url.pathname === "/api/settings/pollinations/models") {
          const kind = url.searchParams.get("kind");
          if (kind === "text" && holdText) {
            const waiting = holdText; holdText = null; textHeld = true;
            await waiting.promise; await route.fulfill({ json: { models: [{ id: "vendor/old-credential-model", name: "Old credential", structuredOutput: true, streaming: true }], checkedAt: "2026-10-19T10:00:00Z" } }); return;
          }
          json = { models: ["a", "b"].map(suffix => ({ id: `vendor/${kind}-${suffix}`, name: `Модель ${suffix}`, structuredOutput: true, streaming: true, paidOnly: suffix === "b" })), checkedAt: "2026-10-19T10:00:00Z", stale: refreshFails, personal: narrator.pollinationsConfigured };
        } else throw new Error(`Unexpected fixture request: ${url.pathname}`);
        await route.fulfill({ status, json });
      });
      await page.route("https://enter.pollinations.ai/**", route => route.fulfill({ contentType: "text/html", body: '<html lang="ru"><h1>Штатный вход Pollinations — фикстура</h1></html>' }));
      await page.goto(base);
      await page.getByRole("combobox", { name: "Провайдер рассказчика", exact: true }).selectOption("pollinations");
      await expect(page.getByRole("combobox", { name: "Модель рассказчика", exact: true })).toHaveValue("");
      const connect = page.getByRole("button", { name: "Подключить аккаунт Pollinations", exact: true });
      await expect(connect).toBeEnabled(); await connect.focus(); await page.keyboard.press("Enter");
      await expect(page).toHaveURL("https://enter.pollinations.ai/authorize?fixture=1");
      expect(textWrites).toEqual([{ provider: "pollinations", model: "", useLiveAI: false }]); expect(connects).toBe(1);
      checks.push(`${viewport.name}:native-login-before-model-or-key`);
      narrator = { ...narrator, model: "vendor/text-a", pollinationsConfigured: true };
      await page.goto(base);
      const personal = page.getByRole("combobox", { name: "Аккаунт для иллюстраций", exact: true });
      await personal.focus(); await page.keyboard.press("End"); await page.keyboard.press("Enter");
      await expect(personal).toHaveValue("personal");
      const model = page.getByRole("combobox", { name: "Модель личных иллюстраций", exact: true });
      await expect(page.getByText("Личный аккаунт подключён. Изображения расходуют ваш Pollen.", { exact: true })).toBeVisible();
      await expect(model).toBeEnabled(); await model.selectOption("vendor/image-b");
      await expect(page.getByText("Черновик иллюстраций", { exact: true })).toHaveCount(0);
      const save = page.getByRole("button", { name: "Сохранить настройки иллюстраций", exact: true });
      denySave = true; await save.click(); await expect(page.getByRole("alert")).toContainText("временно недоступно");
      await expect(model).toHaveValue("vendor/image-b"); await expect(personal).toHaveValue("personal");
      denySave = false; await save.focus(); await page.keyboard.press("Enter");
      await expect(page.getByLabel("Черновик иллюстраций")).toHaveText("сохранён");
      expect(imageWrites).toEqual([{ accountSource: "personal", model: "vendor/image-b" }, { accountSource: "personal", model: "vendor/image-b" }]);
      refreshFails = true; await page.getByRole("button", { name: "Обновить модели изображений" }).click();
      await expect(page.getByText(/Сервис недоступен, показан сохранённый каталог/)).toBeVisible();
      await page.getByText("Ввести ID модели изображения вручную", { exact: true }).click();
      await page.getByLabel("Идентификатор модели изображения", { exact: true }).fill("community/me/custom-image");
      await save.click(); await expect(page.getByLabel("Черновик иллюстраций")).toHaveText("сохранён");
      await page.getByRole("combobox", { name: "Модель рассказчика", exact: true }).selectOption("vendor/text-b");
      await page.getByRole("button", { name: "Сохранить рассказчика", exact: true }).click();
      await expect(page.getByText("Настройки рассказчика сохранены.", { exact: true })).toBeVisible();
      const geometry = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, overflowing: Array.from(document.querySelectorAll<HTMLElement>("body *")).flatMap(element => { const rect = element.getBoundingClientRect(); return element.getClientRects().length && (rect.right > innerWidth + 1 || element.scrollWidth > element.clientWidth + 1) ? [{ tag: element.tagName, className: element.className, text: element.textContent?.slice(0, 120), right: rect.right, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }] : []; }) }));
      await writeFile(`${output}/${viewport.name}-geometry.json`, JSON.stringify(geometry, null, 2));
      expect(geometry.documentWidth, `${viewport.name}: ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(geometry.viewport);
      await page.screenshot({ path: `${output}/${viewport.name}-personal.png`, fullPage: true });
      await page.getByRole("button", { name: "Удалить ключ рассказчика", exact: true }).click();
      await page.getByRole("button", { name: "Сохранить рассказчика", exact: true }).click();
      await expect(page.getByText("Подключите личный аккаунт, чтобы создавать изображения за свой Pollen.", { exact: true })).toBeVisible();
      checks.push(`${viewport.name}:disconnect-updates-image-connection`);
      checks.push(`${viewport.name}:image-payer-model-keyboard`, `${viewport.name}:failed-save-retains-draft`, `${viewport.name}:catalog-stale-visible`, `${viewport.name}:manual-image-model`, `${viewport.name}:narrator-model-select`, `${viewport.name}:no-overflow`);
      await page.reload(); await expect(personal).toHaveValue("personal"); await expect(model).toHaveValue("community/me/custom-image");
      await personal.selectOption("application"); await save.click();
      await expect(page.getByText(/Новые изображения оплачивает аккаунт приложения/)).toBeVisible();
      await page.screenshot({ path: `${output}/${viewport.name}-application.png`, fullPage: true });
      checks.push(`${viewport.name}:persisted-preferences`, `${viewport.name}:explicit-application-payer`);
      images = { ...images, accountSource: "personal", model: "vendor/image-a", pollinationsConfigured: true };
      narrator.pollinationsConfigured = true; failImageLoad = true;
      await page.reload();
      await expect(page.getByText("Не удалось загрузить настройки иллюстраций.", { exact: true })).toBeVisible();
      await page.getByText("Ввести API-ключ вручную", { exact: true }).click();
      await page.getByLabel("Новый API-ключ Pollinations", { exact: true }).fill("sk_browser_fixture_replacement");
      await page.getByRole("button", { name: "Сохранить рассказчика", exact: true }).click();
      await expect(personal).toHaveValue("personal"); await expect(model).toHaveValue("vendor/image-a");
      await expect(page.getByLabel("Черновик иллюстраций")).toHaveText("сохранён");
      checks.push(`${viewport.name}:credential-refresh-initializes-failed-form`);
      await expect(model).toBeEnabled();
      const statusGate = gate(), textGate = gate(); holdMetadata = statusGate; holdText = textGate;
      await page.getByLabel("Новый API-ключ Pollinations", { exact: true }).fill("sk_browser_fixture_next");
      await page.getByRole("button", { name: "Сохранить рассказчика", exact: true }).click();
      await expect.poll(() => metadataHeld && textHeld).toBe(true);
      await page.getByRole("button", { name: "Удалить ключ рассказчика", exact: true }).click();
      await page.getByRole("button", { name: "Сохранить рассказчика", exact: true }).click();
      await expect(page.getByText("Подключите личный аккаунт, чтобы создавать изображения за свой Pollen.", { exact: true })).toBeVisible();
      const statusResponse = page.waitForResponse(response => response.url().endsWith("/api/settings/visual-provider") && response.request().method() === "GET");
      const catalogResponse = page.waitForResponse(response => response.url().includes("/api/settings/pollinations/models?kind=text"));
      statusGate.open(); textGate.open(); await Promise.all([statusResponse, catalogResponse]);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(page.getByText("Подключите личный аккаунт, чтобы создавать изображения за свой Pollen.", { exact: true })).toBeVisible();
      await expect(page.locator('option[value="vendor/old-credential-model"]')).toHaveCount(0);
      checks.push(`${viewport.name}:old-credential-status-ignored`, `${viewport.name}:old-credential-catalog-ignored`);
      images.accountSource = "application";
      const availabilityGate = gate(); holdAvailability = availabilityGate;
      await page.reload(); await expect.poll(() => availabilityHeld).toBe(true);
      const connection = page.locator(".pollinations-connect");
      await expect(connection.getByRole("status")).toHaveText("Проверяем доступность входа Pollinations…");
      await expect(connection.getByRole("button").first()).toBeDisabled();
      await page.screenshot({ path: `${output}/${viewport.name}-connection-loading.png`, fullPage: true });
      availabilityGate.open(); await expect(connection.getByRole("button").first()).toBeEnabled();
      connectAvailable = false; await page.reload();
      await expect(connection.getByRole("status")).toContainText("Вход пока не настроен");
      await expect(connection.getByRole("button").first()).toBeDisabled();
      await expect(page.getByText("Ввести API-ключ вручную", { exact: true })).toBeVisible();
      await page.screenshot({ path: `${output}/${viewport.name}-connection-unconfigured.png`, fullPage: true });
      failAvailability = true; await page.reload();
      await expect(connection.getByRole("alert")).toContainText("Не удалось проверить доступность");
      connectAvailable = true; failAvailability = false;
      const recheck = connection.getByRole("button", { name: "Повторить проверку входа", exact: true });
      await recheck.focus(); await page.keyboard.press("Enter");
      await expect(connection.getByRole("button").first()).toBeEnabled();
      failConnect = true;
      const openConnection = connection.getByRole("button").first();
      await openConnection.focus(); await page.keyboard.press("Enter");
      await expect(connection.getByRole("alert")).toContainText("Вход временно недоступен");
      await expect(page).toHaveURL(base + "/"); await expect(openConnection).toBeEnabled();
      await page.screenshot({ path: `${output}/${viewport.name}-connection-error.png`, fullPage: true });
      failConnect = false;
      checks.push(`${viewport.name}:connection-loading-disabled`, `${viewport.name}:connection-unconfigured-manual-fallback`, `${viewport.name}:connection-availability-keyboard-retry`, `${viewport.name}:connection-open-failure-visible`);
      for (const [result, title] of [["connected", "Аккаунт Pollinations подключён"], ["cancelled", "Подключение Pollinations отменено"], ["failed", "Подключение Pollinations не завершено"]]) {
        await page.goto(`${base}/settings?keep=fixture&pollinations=${result}#text-provider`);
        const notice = page.getByRole("status").filter({ hasText: title });
        await expect(notice).toBeVisible(); await expect(notice).toHaveAttribute("aria-live", "polite");
        const dismiss = page.getByRole("button", { name: "Закрыть сообщение Pollinations", exact: true });
        await dismiss.focus(); await expect(dismiss).toBeFocused();
        await page.screenshot({ path: `${output}/${viewport.name}-return-${result}-focus.png`, fullPage: true });
        await page.keyboard.press("Enter"); await expect(notice).toHaveCount(0);
        await expect(page).toHaveURL(`${base}/settings?keep=fixture#text-provider`);
        await expect(page.getByRole("combobox", { name: "Провайдер рассказчика", exact: true })).toBeFocused();
        checks.push(`${viewport.name}:return-${result}-announced-dismissed-focus-restored`);
      }
      const narratorGate = gate(); holdNarrator = narratorGate;
      await page.goto(`${base}/settings?pollinations=cancelled`);
      const earlyDismiss = page.getByRole("button", { name: "Закрыть сообщение Pollinations", exact: true });
      await earlyDismiss.focus(); await page.keyboard.press("Enter");
      await expect(page.locator("#text-provider-heading")).toBeFocused();
      narratorGate.open();
      await expect(page.getByRole("combobox", { name: "Провайдер рассказчика", exact: true })).toBeVisible();
      checks.push(`${viewport.name}:return-dismiss-before-settings-loaded-focuses-heading`);
      await page.close();
    }
    expect(errors).toEqual([]);
    await writeFile(`${output}/result.json`, JSON.stringify({ checks, count: checks.length, errors, scope: "actual components, synthetic HTTP only; provider login page replaced with a local response" }, null, 2));
    console.log(`Pollinations settings browser: ${checks.length} checks passed`);
  } catch (error) { if (active && !active.isClosed()) await active.screenshot({ path: `${output}/failure.png`, fullPage: true }); throw error; }
  finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
