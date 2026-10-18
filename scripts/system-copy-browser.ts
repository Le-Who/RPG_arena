/** Actual diagnostic component with synthetic API responses; no Next auth, DB or providers. */
import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PRODUCT_INFO } from "../src/lib/product-info";

async function main() {
  const output = resolve("output/playwright/system-copy");
  await mkdir(output, { recursive: true });
  const bundle = await build({
    stdin: { contents: 'import {createRoot} from "react-dom/client"; import {SystemPanel} from "./src/components/system-panel"; createRoot(document.getElementById("root")).render(<SystemPanel/>);', resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "isolated-app-context", setup(builder) {
      builder.onResolve({ filter: /^\.\/app-shell$/ }, () => ({ path: "app-context", namespace: "fixture" }));
      builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ loader: "tsx", resolveDir: process.cwd(), contents: args.path === "link"
        ? 'export default function Link(props){return <a {...props}/>;}'
        : "export function useApp(){return {notify:()=>{}}}" }));
    } }],
  });
  const css = (await Promise.all(["globals", "pages", "dialogs", "shell"].map(name => readFile(`src/app/${name}.css`, "utf8")))).join("\n").replace('@import "tailwindcss";', "");
  const html = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><body><main id="root" style="padding:16px"></main><script src="/fixture.js"></script></body></html>';
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : req.url === "/fixture.css" ? "text/css" : "text/html");
    res.end(req.url === "/fixture.js" ? bundle.outputFiles[0].text : req.url === "/fixture.css" ? css : html);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch();
  const checks: string[] = [];
  try {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    let capabilities = { generation: false, embeddings: false, extraction: false, hasKeys: false, model: "gemini-embedding-2", dims: 768 };
    let worker = { online: false, status: "not-started", lastSeenAt: null as string | null, report: null };
    let processed = 0;
    await page.route("**/api/system/status", route => route.fulfill({ json: {
      version: PRODUCT_INFO.version, checkedAt: "2026-10-19T12:00:00Z", database: "connected", capabilities,
      turns: { running: 0, completed: 3 }, checkpoints: 1, campaigns: 1,
      queues: { semantic: { pending: 1, failed: 1 }, embeddings: { pending: 1 }, staleSpace: 1 },
      worker, lastManual: null, recentJobs: [],
    } }));
    await page.route("**/api/system/process", async route => { processed++; await route.fulfill({ json: { extracted: 2, indexed: 0, queued: 1 } }); });
    for (const [width, height] of [[1440, 1000], [390, 844]]) {
      await page.setViewportSize({ width, height });
      capabilities = { ...capabilities, generation: false, embeddings: false, extraction: false, hasKeys: false };
      await page.goto(base);
      await expect(page.locator(".system-health-strip")).toContainText(`CHRONICLE ${PRODUCT_INFO.version}`);
      await expect(page.getByText("Нет свежего сигнала", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Обработать очередь", exact: true })).toBeDisabled();
      await expect(page.getByText(/Извлечение фактов недоступно/)).toBeVisible();
      await expect(page.getByText(/Для векторного поиска нужен ключ Gemini/)).toBeVisible();
      checks.push(`${width}: no narrator or embedding key`);
      capabilities = { ...capabilities, generation: true, extraction: true };
      await page.reload();
      await expect(page.getByRole("button", { name: "Обработать очередь", exact: true })).toBeEnabled();
      await expect(page.getByText(/Извлечение фактов недоступно/)).toHaveCount(0);
      await expect(page.getByText(/Задания ожидают подключения AI/)).toHaveCount(0);
      await expect(page.getByText(/Для векторного поиска нужен ключ Gemini/)).toBeVisible();
      await page.getByRole("button", { name: "Обновить", exact: true }).focus();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("link", { name: "Настройки памяти", exact: true })).toBeFocused();
      const before = processed;
      await page.getByRole("button", { name: "Обработать очередь", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => processed).toBe(before + 1);
      await expect(page.getByRole("button", { name: "Обработать очередь", exact: true })).toBeEnabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: `${output}/external-${width}.png`, fullPage: true });
      checks.push(`${width}: external extraction without Gemini, keyboard process, no overflow`);
      capabilities = { ...capabilities, hasKeys: true, extraction: false };
      worker = { online: true, status: "paused", lastSeenAt: "2026-10-19T12:00:00Z", report: null };
      await page.reload();
      await expect(page.getByText("На связи · пауза", { exact: true })).toBeVisible();
      await expect(page.getByText(/Извлечение фактов выключено/)).toBeVisible();
      await expect(page.getByText(/Векторный поиск выключен/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Обработать очередь", exact: true })).toBeDisabled();
      await page.getByRole("button", { name: /Повторить ошибки/ }).click();
      await expect(page.getByRole("dialog")).toContainText("квоту выбранного рассказчика и Gemini-эмбеддингов");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.screenshot({ path: `${output}/disabled-${width}.png`, fullPage: true });
      checks.push(`${width}: disabled features, paused heartbeat, retry disclosure and Escape`);
      worker = { online: false, status: "not-started", lastSeenAt: null, report: null };
    }
    expect(errors).toEqual([]);
    await writeFile(`${output}/result.json`, JSON.stringify({ checks, errors, processed }, null, 2));
    console.log(`PASS diagnostic copy and capabilities: ${checks.length} scenarios, desktop/mobile, keyboard, no page errors.`);
  } finally { await browser.close(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
