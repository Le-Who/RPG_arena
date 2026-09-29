/** Isolated Chromium component fixture: no Next route, identity, database or provider access. */
import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildTurnReport, buildVitalsReport } from "../src/lib/performance-report";
import { measurePromptBudget } from "../src/lib/prompt-budget";

async function main() {
  const output = resolve("output/playwright/performance");
  await mkdir(output, { recursive: true });
  const bundle = await build({ stdin: { contents: 'import React from "react"; import {createRoot} from "react-dom/client"; import {PerformancePanel} from "./src/components/performance-panel"; createRoot(document.getElementById("root")).render(<PerformancePanel/>);', resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, tsconfig: "tsconfig.json" });
  const css = (await Promise.all(["globals", "pages", "observability"].map(name => readFile(`src/app/${name}.css`, "utf8")))).join("\n").replace('@import "tailwindcss";', "");
  const html = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><body><main id="root" style="max-width:1200px;margin:auto;padding:16px"></main><script src="/fixture.js"></script></body></html>';
  const server = createServer((req, res) => { res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : req.url === "/fixture.css" ? "text/css" : "text/html"); res.end(req.url === "/fixture.js" ? bundle.outputFiles[0].text : req.url === "/fixture.css" ? css : html); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const report = {
    generatedAt: new Date().toISOString(), windowDays: 7, retentionDays: 14, turnWindowDays: 30, telemetryEnabled: false, sampleLimit: 20000, turnLimit: 500,
    vitals: buildVitalsReport([{ metric: "LCP", route: "/play/[id]", device: "mobile", value: 2900 }, { metric: "API_AUTH", route: "/", device: "desktop", value: 100 }]),
    turns: buildTurnReport([{ model: "fixture-model", timings: { serverMs: 1600, generationMs: 1200, attempts: 1 }, budget: measurePromptBudget({ system: "s".repeat(6000), user: "u".repeat(1000), sections: { memory: "m".repeat(2000), scenario: "s".repeat(1000) } }) }]),
  };
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let mode: "loading" | "report" | "error" = "loading";
    const requests: string[] = [];
    await page.route("**/api/system/performance?*", async route => {
      requests.push(route.request().url());
      if (mode === "loading") await gate;
      await route.fulfill({ status: mode === "error" ? 503 : 200, contentType: "application/json", body: JSON.stringify(mode === "error" ? { message: "Тестовая ошибка загрузки" } : report) });
    });
    await page.goto(`http://127.0.0.1:${port}/`);
    await expect(page.getByRole("status")).toContainText("Читаем замеры");
    await page.screenshot({ path: `${output}/loading.png` });
    mode = "report"; release();
    await expect(page.getByRole("heading", { name: /Web Vitals/ })).toBeVisible();
    await expect(page.getByText(/Сбор браузерных замеров выключен/)).toBeVisible();
    await page.screenshot({ path: `${output}/desktop.png`, fullPage: true });
    const selector = page.getByRole("combobox", { name: "Окно замеров" });
    await selector.focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    await expect(selector).toHaveValue("1");
    await expect.poll(() => requests.some(url => url.endsWith("days=1"))).toBe(true);
    await expect(page.getByRole("button", { name: "Обновить" })).toBeEnabled();
    await page.keyboard.press("Escape");
    await selector.focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Обновить" })).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${output}/mobile.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("region", { name: "Этапы хода на сервере", exact: true }).focus();
    await expect(page.getByRole("region", { name: "Этапы хода на сервере", exact: true })).toBeFocused();
    mode = "error";
    await page.reload();
    await expect(page.getByRole("alert")).toContainText("Тестовая ошибка загрузки");
    await expect(page.getByRole("status")).toHaveCount(0);
    await page.screenshot({ path: `${output}/error.png` });
    expect(errors).toEqual([]);
    await writeFile(`${output}/result.json`, JSON.stringify({ checks: ["loading", "report", "desktop", "mobile-no-overflow", "keyboard-selector", "keyboard-table", "error-without-spinner"], requests: requests.length, errors }, null, 2));
    console.log(`Performance panel Chromium checks passed: ${output}`);
  } finally { await browser.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
