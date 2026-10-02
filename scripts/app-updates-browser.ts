/** Two real production builds, one origin, two open tabs; isolated API fixtures only. */
import { chromium, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request } from "node:http";
import { createWriteStream, readdirSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { installUiMock, mockSessionId, mockSnapshot } from "./ui-mock";

const output = "output/playwright/app-updates";
const upstreamPort = 3143;
const env = { ...process.env };
// Do not load deployment credentials from .env into this disposable test server/build.
for (const file of readdirSync(".").filter(name => /^\.env(?:\.|$)/.test(name))) {
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const name = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
    if (name) env[name] = "";
  }
}
Object.assign(env, { DATABASE_URL: "postgresql://test:test@127.0.0.1:1/chronicle_build", CHRONICLE_AUTO_MIGRATE: "0", CHRONICLE_TELEMETRY_ENABLED: "0", NEXT_TELEMETRY_DISABLED: "1" });
let app: ChildProcess | undefined;
async function build(id: string) {
  console.log(`Building ${id}`);
  const log = createWriteStream(`${output}/${id}-build.log`);
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "build"], { env: { ...env, CHRONICLE_BUILD_ID: id }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log); child.stderr.pipe(log);
  const code = await new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  log.end();
  if (code !== 0) throw Error(`Build ${id} failed (${code}); see ${output}`);
  expect(readFileSync(".next/BUILD_ID", "utf8")).toBe(id);
}
async function stopApp() {
  if (!app || app.exitCode !== null) return;
  const stopped = new Promise(resolve => app!.once("exit", resolve));
  app.kill(); await stopped; app = undefined;
}
async function start(id: string) {
  const log = createWriteStream(`${output}/${id}-server.log`);
  // Intentionally omit the build override at runtime: compiled IDs must remain stable.
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(upstreamPort)], { env, stdio: ["ignore", "pipe", "pipe"] });
  app.stdout!.pipe(log); app.stderr!.pipe(log); app.once("exit", () => log.end());
  await expect.poll(async () => {
    try { return await (await fetch(`http://127.0.0.1:${upstreamPort}/api/version`)).json(); } catch { return null; }
  }, { timeout: 30_000 }).toEqual({ buildId: id });
}
async function main() {
  await mkdir(output, { recursive: true });
  // A test-only reverse proxy strips cookies even on browser reload and SW fetches.
  // Browser route.continue cannot reliably strip Cookie; this keeps proxy away from any database.
  const proxy = createServer((req, res) => {
    const headers = { ...req.headers }; delete headers.cookie;
    const upstream = request({ hostname: "127.0.0.1", port: upstreamPort, path: req.url, method: req.method, headers }, response => {
      const responseHeaders = { ...response.headers }; delete responseHeaders["set-cookie"];
      res.writeHead(response.statusCode ?? 502, responseHeaders); response.pipe(res);
    });
    upstream.on("error", () => { res.writeHead(503); res.end("Fixture server restarting"); });
    req.pipe(upstream);
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address(); if (!address || typeof address === "string") throw Error("Missing proxy address");
  const base = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch();
  try {
    await build("update-fixture-a"); await start("update-fixture-a");
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    const first = await context.newPage(), second = await context.newPage();
    const errors: string[] = [];
    const setup = async (page: Page) => {
      page.on("pageerror", error => errors.push(error.message));
      await installUiMock(page);
      await page.route(`**/api/sessions/${mockSessionId}?*`, route => route.fulfill({ json: { ...mockSnapshot, isOwner: true } }));
      await page.route("**/api/version", route => route.continue());
      await page.goto(`${base}/play/${mockSessionId}`);
      await expect(page.getByRole("textbox", { name: "Ваше действие", exact: true })).toBeEditable();
      await expect(page.locator('meta[name="chronicle-build"]')).toHaveAttribute("content", "update-fixture-a");
    };
    await setup(first); await setup(second);
    const composer = first.getByRole("textbox", { name: "Ваше действие", exact: true });
    await composer.fill("Изучить Карта");
    await first.getByRole("option", { name: /Карта побережья/ }).click();
    const draft = await composer.inputValue();
    await second.getByRole("textbox", { name: "Ваше действие", exact: true }).fill("Черновик второй вкладки");
    await expect.poll(() => first.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    const oldAsset = await first.evaluate(async () => {
      const script = document.querySelector<HTMLScriptElement>('script[src*="/_next/static/"]')!.src;
      await fetch(script); return script;
    });
    const oldScript = await first.evaluate(async url => (await fetch(url)).text(), oldAsset);
    const workerA = await (await fetch(`${base}/sw.js`)).text();
    const shellA = await first.evaluate(async () => (await caches.keys()).filter(name => name.includes("offline")));
    await stopApp(); await build("update-fixture-b"); await start("update-fixture-b");
    expect(await (await fetch(`${base}/sw.js`)).text()).not.toBe(workerA);
    for (const page of [first, second]) {
      await page.bringToFront();
      // A focus during server restart may have used the 30-second throttle slot.
      await expect.poll(async () => {
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        return page.getByText("Доступна новая версия", { exact: true }).isVisible();
      }, { timeout: 40_000, intervals: [1000, 5000] }).toBe(true);
      await expect(page.locator('meta[name="chronicle-build"]')).toHaveAttribute("content", "update-fixture-a");
    }
    await first.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.update(); });
    await expect.poll(() => first.evaluate(async () => (await caches.keys()).filter(name => name.includes("offline"))), { timeout: 15_000 }).not.toEqual(shellA);
    expect(await second.evaluate(async url => (await fetch(url)).text(), oldAsset)).toBe(oldScript);
    await first.bringToFront();
    await first.screenshot({ path: `${output}/available-desktop.png` });
    await first.getByRole("button", { name: "Обновить приложение", exact: true }).click();
    await expect(first.locator('meta[name="chronicle-build"]')).toHaveAttribute("content", "update-fixture-b", { timeout: 20_000 });
    await expect(first.getByRole("textbox", { name: "Ваше действие", exact: true })).toHaveValue(draft);
    await expect(second.locator('meta[name="chronicle-build"]')).toHaveAttribute("content", "update-fixture-a");
    await expect(second.getByRole("textbox", { name: "Ваше действие", exact: true })).toHaveValue("Черновик второй вкладки");
    await second.bringToFront();
    await second.setViewportSize({ width: 390, height: 844 });
    await expect(second.getByRole("button", { name: "Обновить приложение", exact: true })).toBeInViewport();
    await second.screenshot({ path: `${output}/available-mobile.png` });
    expect(await second.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    let sent: { itemIds?: string[] } | undefined;
    await first.route(`**/api/sessions/${mockSessionId}/act`, route => { sent = route.request().postDataJSON(); return route.fulfill({ status: 503, json: { error: "Тест: временно недоступно" } }); });
    await first.getByRole("button", { name: "Сделать ход", exact: true }).click();
    await expect.poll(() => sent?.itemIds).toEqual(["40000000-0000-4000-8000-000000000001"]);
    // Restore must not consume a different saved draft while request recovery owns the composer.
    await first.evaluate(({ campaignId }) => sessionStorage.setItem("chronicle:update-draft:v1", JSON.stringify({
      profileId: "guest:ui-audit-fixture", campaignId, action: "Отложенный черновик после восстановления",
      itemBindings: [], savedAt: Date.now(),
    })), { campaignId: mockSessionId });
    await first.reload();
    await expect(first.getByRole("button", { name: "Отложить действие", exact: true })).toBeVisible();
    expect(await first.evaluate(() => sessionStorage.getItem("chronicle:update-draft:v1"))).not.toBeNull();
    await first.getByRole("button", { name: "Отложить действие", exact: true }).click();
    await expect(first.getByRole("textbox", { name: "Ваше действие", exact: true })).toHaveValue("Отложенный черновик после восстановления");
    expect(await first.evaluate(() => sessionStorage.getItem("chronicle:update-draft:v1"))).toBeNull();
    const paths = await first.evaluate(async () => (await Promise.all((await caches.keys()).map(async name => (await (await caches.open(name)).keys()).map(r => new URL(r.url).pathname)))).flat());
    expect(paths.every(path => path.startsWith("/_next/static/") || ["/offline.html", "/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png"].includes(path))).toBe(true);
    expect(errors).toEqual([]);
    console.log("PASS: two production builds; consistent build IDs; two old tabs; immediate SW activation; preserved old chunks; voluntary one-tab reload; restored draft + exact item binding; mobile; no private caches.");
  } finally { await browser.close(); await stopApp(); proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
