/** Actual settings/gallery components; synthetic HTTP contracts, no database or provider calls. */
import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { launchFixtureBrowser } from "./lib/launch-fixture-browser";

const providerErrors = [
  ["OPENAI_KEY_REQUIRED", "Добавьте API-ключ OpenAI в настройках подключений."],
  ["OPENAI_AUTH_FAILED", "OpenAI отклонил API-ключ. Замените его в настройках подключений."],
  ["OPENAI_ACCESS_DENIED", "Нет доступа к генерации изображений OpenAI. Проверьте права ключа и доступ проекта к модели."],
  ["OPENAI_RATE_LIMITED", "OpenAI сообщил о лимите запросов или квоте. Проверьте лимиты и баланс API-проекта, затем повторите."],
  ["OPENAI_REQUEST_REJECTED", "OpenAI отклонил запрос изображения. Проверьте выбранную модель или попробуйте другое описание."],
  ["OPENAI_MODEL_UNAVAILABLE", "Выбранная модель OpenAI недоступна. Выберите другую модель иллюстраций в настройках."],
  ["constructor", "constructor"],
] as const;

async function main() {
  const output = resolve("output/playwright/openai-image-settings");
  await mkdir(output, { recursive: true });
  const bundle = await build({
    stdin: { contents: `
      import React,{useCallback,useState} from "react";import {createRoot} from "react-dom/client";
      import {ServiceConnections} from "./src/components/service-connections";
      import {ImageProviderSettings} from "./src/components/image-provider-settings";
      import {TextProviderSettings} from "./src/components/text-provider-settings";
      import {VisualGallery} from "./src/components/visual-gallery";
      const geminiModels={narrationModel:"gemini-3.5-flash-lite",customActionModel:"gemini-3.8-flash",compactionModel:"gemini-3.8-flash",fastTaskModel:"gemini-3.5-flash-lite"};
      function Fixture(){const [revision,setRevision]=useState(0);const noop=useCallback(()=>{},[]);
        const saved=useCallback(()=>{setRevision(value=>value+1)},[]),beforeConnect=useCallback(async()=>true,[]);
        if(location.search.includes("gallery"))return <VisualGallery sessionId="synthetic" isOwner={true} npcs={[]} currentLocationId={null} lastTurn={1}/>;
        return <><ServiceConnections onDirtyChange={noop} onSaveReady={noop} onSaved={saved} beforeConnect={beforeConnect}/>
          <TextProviderSettings onDirtyChange={noop} onSaveReady={noop} onSaved={noop} geminiConfigured={true} geminiModels={geminiModels} onGeminiModelChange={noop} connectionRevision={revision}/>
          <ImageProviderSettings onDirtyChange={noop} onSaveReady={noop} connectionRevision={revision}/></>;}
      createRoot(document.getElementById("root")).render(<Fixture/>);
    `, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, outfile: "fixture.js", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "isolated-next-link", setup(build) {
      build.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'import React from "react";export default function Link({children,...props}){return <a {...props}>{children}</a>}', loader: "tsx", resolveDir: process.cwd() }));
    } }],
  });
  const css = (await Promise.all(["globals", "pages", "preferences", "dialogs", "theatre", "life"].map(name => readFile(`src/app/${name}.css`, "utf8")))).join("\n").replace('@import "tailwindcss";', "");
  const html = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><body><main id="root" style="max-width:1000px;margin:auto;padding:16px"></main><script src="/fixture.js"></script></body></html>';
  const server = createServer((req, res) => { res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : req.url === "/fixture.css" ? "text/css" : "text/html"); res.end(req.url === "/fixture.js" ? bundle.outputFiles[0].text : req.url === "/fixture.css" ? css : html); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await launchFixtureBrowser(server, () => chromium.launch());
  const checks: string[] = [], errors: string[] = [];
  try {
    for (const width of [1280, 390, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
      page.on("pageerror", error => errors.push(error.message));
      const connections = { geminiConfigured: true, openrouterConfigured: true, pollinationsConfigured: true, openaiConfigured: false };
      const narrator = { provider: "gemini", model: "", openrouterConfigured: true, pollinationsConfigured: true, useLiveAI: true };
      let images = { enabled: true, provider: "openrouter", endpoint: "seed" as string | null, accountSource: "personal", model: "image/previous", applicationModel: "image/application", applicationConfigured: true, pollinationsConfigured: true, openrouterConfigured: true, openaiConfigured: false };
      const writes: Array<{ path: string; body: Record<string, unknown> }> = [], catalogs: URL[] = [];
      await page.route("**/api/**", async route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() === "POST") writes.push({ path: url.pathname, body: request.postDataJSON() });
        let data: unknown;
        if (url.pathname === "/api/settings/provider-connections") {
          if (request.method() === "POST") {
            const input = request.postDataJSON();
            expect(input.provider).toBe("openai");
            connections.openaiConfigured = !input.clearKey;
            images = { ...images, openaiConfigured: connections.openaiConfigured };
          }
          data = connections;
        } else if (url.pathname === "/api/settings/text-provider") data = narrator;
        else if (url.pathname === "/api/settings/visual-provider") {
          if (request.method() === "POST") images = { ...images, ...request.postDataJSON() };
          data = images;
        } else if (url.pathname === "/api/settings/visual-provider/models") {
          catalogs.push(url);
          data = { models: url.searchParams.get("provider") === "openai" ? [
            { id: "gpt-image-2.5-flare", name: "GPT Image 2.5 Flare", generationSupported: true },
            { id: "gpt-image-1.5", name: "GPT Image 1.5", generationSupported: true },
          ] : [{ id: "image/previous", name: "Предыдущая модель", endpoint: "seed", generationSupported: true }], checkedAt: "2026-10-30T12:00:00Z", stale: false };
        } else if (url.pathname === "/api/settings/pollinations/connect") data = { available: false };
        else if (url.pathname === "/api/sessions/synthetic/visuals") {
          const authenticated = page.url().includes("gallery-errors");
          const visual = { id: "synthetic-image", kind: "scene", subjectKey: "scene:1", turnNumber: 1, caption: "Тихий сад", provider: "openai", model: "gpt-image-2.5-flare", seed: 1, status: "failed", error: "Нет подключения", width: 1024, height: 1024, accountSource: "personal", generationBlocked: !authenticated };
          data = {
            visuals: authenticated ? providerErrors.map(([error], index) => ({ ...visual, id: `error-${index}`, error })) : [visual],
            identities: [], config: { enabled: true, provider: "openai", accountSource: "personal", availableAccounts: { application: false, personal: authenticated }, model: "gpt-image-2.5-flare", dailyLimit: 10, authenticated },
          };
        }
        else throw Error(`Unexpected API ${url.pathname}`);
        await route.fulfill({ json: data });
      });
      await page.goto(base);
      const narratorProvider = page.getByRole("combobox", { name: "Провайдер рассказчика", exact: true });
      await expect(narratorProvider).toHaveValue("gemini");
      expect(await narratorProvider.locator("option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).not.toContain("openai");
      await expect(page.locator("#text-provider .ai-task-status")).toContainText("Готов к генерации");
      await page.getByRole("button", { name: "Подключить OpenAI", exact: true }).click();
      const key = page.getByLabel("API-ключ OpenAI", { exact: true });
      await expect(key).toHaveAttribute("type", "password");
      await expect(key).toHaveValue("");
      await expect(page.getByRole("link", { name: "Получить ключ OpenAI", exact: true })).toHaveAttribute("href", "https://platform.openai.com/api-keys");
      await expect(page.locator("#service-connections")).toContainText("Для иллюстраций. Оплата с баланса API OpenAI.");
      await key.fill("synthetic-openai-key");
      await page.getByRole("button", { name: "Сохранить подключения", exact: true }).click();
      await expect(page.getByRole("button", { name: "Изменить OpenAI", exact: true })).toBeVisible();
      await expect(key).toHaveValue("");
      expect(await page.content()).not.toContain("synthetic-openai-key");
      expect(writes).toEqual([{ path: "/api/settings/provider-connections", body: { provider: "openai", apiKey: "synthetic-openai-key" } }]);
      checks.push(`${width}:personal-key-save-clears-password-without-changing-tasks`);

      await page.getByRole("button", { name: "Изменить иллюстрации", exact: true }).click();
      const imageProvider = page.getByRole("combobox", { name: "Сервис иллюстраций", exact: true });
      await imageProvider.selectOption("openai");
      await expect(page.getByRole("radio", { name: /GPT Image 2.5 Flare/ })).toBeVisible();
      await expect(page.locator("#visual-provider .ai-payer")).toHaveText("Оплата: ваш аккаунт OpenAI.");
      await expect(page.getByRole("combobox", { name: "Аккаунт для иллюстраций", exact: true })).toHaveCount(0);
      expect(catalogs.filter(url => url.searchParams.get("provider") === "openai").every(url => !url.searchParams.has("endpoint"))).toBe(true);
      await page.getByRole("radio", { name: /GPT Image 2.5 Flare/ }).focus();
      await page.keyboard.press("Space");
      await expect(page.getByRole("radio", { name: /GPT Image 2.5 Flare/ })).toBeChecked();
      await expect(page.locator("#visual-provider .ai-task-price")).toContainText("Нет данных о цене");
      await page.getByRole("button", { name: "Сохранить настройки иллюстраций", exact: true }).click();
      await expect(page.getByText("Настройки новых иллюстраций сохранены.", { exact: true })).toBeVisible();
      expect(writes[1]).toEqual({ path: "/api/settings/visual-provider", body: { enabled: true, provider: "openai", accountSource: "personal", model: "gpt-image-2.5-flare", endpoint: null } });
      await expect(page.locator("#visual-provider .settings-card-heading")).toContainText("OpenAI · GPT Image 2.5 Flare");
      await expect(page.locator("#visual-provider .ai-task-status")).not.toContainText("Нужно подключить сервис");
      await expect(narratorProvider).toHaveValue("gemini");
      checks.push(`${width}:keyboard-model-selection-clears-old-endpoint-and-keeps-narrator`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${output}/${width}-connected.png`, fullPage: true });

      const disconnect = page.getByRole("button", { name: "Отключить OpenAI", exact: true });
      await disconnect.click();
      const dialog = page.getByRole("dialog", { name: "Отключить OpenAI?", exact: true });
      await expect(dialog).toContainText("иллюстрации");
      await expect(dialog).not.toContainText("рассказчик");
      await page.keyboard.press("Escape");
      await expect(disconnect).toBeFocused();
      await disconnect.click();
      await page.getByRole("button", { name: "Отключить при сохранении", exact: true }).click();
      await page.getByRole("button", { name: "Сохранить подключения", exact: true }).click();
      await expect(page.locator("#visual-provider .ai-task-status")).toContainText("Нужно подключить сервис");
      await expect(page.locator("#text-provider .ai-task-status")).toContainText("Готов к генерации");
      await expect(page.getByRole("radio", { name: /GPT Image 2.5 Flare/ })).toBeChecked();
      expect(writes[2]).toEqual({ path: "/api/settings/provider-connections", body: { provider: "openai", clearKey: true } });
      checks.push(`${width}:disconnect-keeps-model-and-narrator-readiness`);

      await imageProvider.selectOption("pollinations");
      await page.getByRole("combobox", { name: "Аккаунт для иллюстраций", exact: true }).selectOption("application");
      await imageProvider.selectOption("openai");
      await expect(page.locator("#visual-provider .ai-payer")).toHaveText("Оплата: ваш аккаунт OpenAI.");
      await expect(page.getByRole("button", { name: "Сохранить настройки иллюстраций", exact: true })).toBeDisabled();
      expect(writes).toHaveLength(3);
      checks.push(`${width}:application-payer-does-not-carry-into-openai`);

      await page.goto(`${base}/?gallery-errors`);
      for (const [code, message] of providerErrors) {
        await expect(page.getByText(message, { exact: true })).toBeVisible();
        if (code !== message) await expect(page.locator(".lx-gallery")).not.toContainText(code);
      }
      checks.push(`${width}:gallery-renders-actionable-openai-errors`);
      await page.goto(`${base}/?gallery`);
      await expect(page.locator(".lx-gallery")).toContainText("ваш аккаунт OpenAI");
      await expect(page.getByRole("alert")).toContainText("Выбранный аккаунт OpenAI недоступен");
      await expect(page.locator("figcaption")).toContainText("Личный аккаунт OpenAI · gpt-image-2.5-flare");
      await expect(page.getByRole("button", { name: "Повторить создание", exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${output}/${width}-gallery.png`, fullPage: true });
      checks.push(`${width}:gallery-label-and-unavailable-state`);
      await page.close();
    }
    expect(errors).toEqual([]);
    await writeFile(`${output}/result.json`, JSON.stringify({ checks, errors, scope: "Actual settings/gallery; synthetic HTTP only; no database or provider calls" }, null, 2));
    console.log(`OpenAI image settings browser checks passed: ${checks.length}`);
  } finally { await browser.close(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
