/** Readability audit with actual pages and isolated API fixtures; no real database/provider. */
import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { createWriteStream, readdirSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { installUiMock, mockSessionId, mockSnapshot } from "./ui-mock";

async function main() {
  const output = "output/playwright/game-copy";
  await mkdir(output, { recursive: true });
  const env = { ...process.env };
  for (const file of readdirSync(".").filter(name => /^\.env(?:\.|$)/.test(name))) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const name = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
      if (name) env[name] = "";
    }
  }
  Object.assign(env, { DATABASE_URL: "postgresql://test:test@127.0.0.1:1/chronicle_copy", CHRONICLE_AUTO_MIGRATE: "0", CHRONICLE_TELEMETRY_ENABLED: "0", NEXT_TELEMETRY_DISABLED: "1" });
  const log = createWriteStream(`${output}/server.log`);
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", "3145"], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.pipe(log); server.stderr.pipe(log);
  const base = "http://127.0.0.1:3145";
  const browser = await chromium.launch();
  try {
    await expect.poll(async () => { try { return (await fetch(`${base}/offline.html`)).status; } catch { return 0; } }, { timeout: 45_000 }).toBe(200);
    const page = await browser.newPage({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    await installUiMock(page);
    await page.route(`**/api/sessions/${mockSessionId}/recap`, route => route.fulfill({ json: { recap: {
      headline: "Ранее в истории", awayLabel: "несколько дней назад", markdown: "Печать настоящая.",
      sections: [{ id: "scene", title: "Где вы остановились", lines: ["Посланник отметил на карте безопасный путь."] }],
    } } }));
    await page.route(`**/api/sessions/${mockSessionId}/visuals`, route => route.fulfill({ json: {
      config: { enabled: true, authenticated: true, provider: "pollinations", model: "fixture-image-model", dailyLimit: 12 },
      visuals: [], identities: [{ id: "identity", subjectKey: "hero", subjectName: "Элиан", passport: "Серый плащ", seed: 987654, referenceVisualId: null }],
    } }));
    const goto = async (path: string) => { await page.context().clearCookies(); await page.goto(base + path); };
    for (const [width, height] of [[1440, 1000], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await goto(`/play/${mockSessionId}`);
      await expect(page.getByRole("textbox", { name: "Ваше действие", exact: true })).toBeEditable();
      await expect(page.locator(".gx-composer-foot, .gx-side-foot, .imagination-card")).toHaveCount(0);
      await expect(page.locator(".gx-dice-body")).toContainText("d20 · сложность 13");
      expect(await page.locator("main").innerText()).not.toMatch(/requestId|Серверный|Офлайн-движок|Модель предлагает|Подтверждено сервером/);
      await page.screenshot({ path: `${output}/play-${width}.png` });
      await page.getByRole("tab", { name: "Образы", exact: true }).click();
      await expect(page.getByText(/передаются сервису pollinations/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Новый облик", exact: true })).toBeVisible();
      expect(await page.locator(".lx-gallery").innerText()).not.toMatch(/seed|fixture-image-model|серверный ключ/);
      await page.screenshot({ path: `${output}/visuals-${width}.png` });
      await goto("/memory");
      await expect(page.getByRole("heading", { name: "Печать Хранителей", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Поиск по смыслу", exact: true })).toBeDisabled();
      await expect(page.getByText(/Поиск по словам доступен/)).toBeVisible();
      expect(await page.locator("main").innerText()).not.toMatch(/PostgreSQL|gemini-embedding|измерений|МОДЕЛЬ ПАМЯТИ|СЕМАНТИЧЕСКИЙ ИНДЕКС|Сходство/);
      await page.getByRole("textbox", { name: "Поиск по истории" }).fill("Печать");
      await expect(page.locator(".memory-card")).toHaveCount(1);
      await expect(page.getByRole("link", { name: "К исходному ходу" })).toHaveAttribute("href", `/play/${mockSessionId}#turn-3`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: `${output}/memory-${width}.png` });
    }
    await goto(`/play/${mockSessionId}`);
    await page.getByRole("button", { name: "Обновления движка" }).click();
    await expect(page.getByRole("dialog")).toContainText("Обновление 2.10");
    await expect(page.getByRole("dialog")).toContainText("с сохранением черновика");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Как это работает" }).click();
    await expect(page.getByRole("dialog")).toContainText("подключите рассказчика");
    expect(await page.getByRole("dialog").innerText()).not.toMatch(/эмбед|Gemini|семантическ/);
    await page.keyboard.press("Escape");
    await goto("/blueprint");
    await expect(page.getByText(/локальная версия 2.10/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Обновление приложения", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    expect(mockSnapshot.memories.length).toBe(2);
    console.log("PASS game, memory, gallery, help and release copy; desktop/mobile; text search and source link; keyboard dialogs; privacy disclosure preserved.");
  } finally {
    await browser.close();
    if (server.exitCode === null) { const stopped = new Promise(resolve => server.once("exit", resolve)); server.kill(); await stopped; }
    log.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
