/** Two real production builds, one origin, two open tabs; isolated API fixtures only. */
import { chromium, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request } from "node:http";
import { createWriteStream, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { installUiMock, mockSessionId, mockSnapshot } from "./ui-mock";

const output = "output/p1-continuation/pwa";
const upstreamPort = 3143;
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (/GEMINI|OPENROUTER|TYPESAFE|POLLINATIONS|CHRONICLE_SECRET|CHRONICLE_ADMIN_ACCOUNT/.test(name)) env[name] = "";
}
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
  app.kill();
  const timer = setTimeout(() => app?.kill("SIGKILL"), 5000);
  try { await stopped; } finally { clearTimeout(timer); app = undefined; }
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
    upstream.on("error", () => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(503); res.end("Fixture server restarting");
    });
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
    const navigationCounts = new Map<Page, number>([[first, 0], [second, 0]]);
    const setup = async (page: Page, buildId = "update-fixture-a") => {
      page.on("pageerror", error => errors.push(error.message));
      page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigationCounts.set(page, (navigationCounts.get(page) ?? 0) + 1); });
      await installUiMock(page);
      await page.route(`**/api/sessions/${mockSessionId}?*`, route => route.fulfill({ json: { ...mockSnapshot, isOwner: true } }));
      await page.route("**/api/version", route => route.continue());
      await page.goto(`${base}/play/${mockSessionId}`);
      await expect(page.getByRole("textbox", { name: "Ваше действие", exact: true })).toBeEditable();
      await expect(page.locator('meta[name="chronicle-build"]')).toHaveAttribute("content", buildId);
    };
    await setup(first); await setup(second);
    const composer = first.getByRole("textbox", { name: "Ваше действие", exact: true });
    await composer.fill("Изучить Карта");
    await first.getByRole("option", { name: /Карта побережья/ }).click();
    const draft = await composer.inputValue();
    await second.getByRole("textbox", { name: "Ваше действие", exact: true }).fill("Черновик второй вкладки");
    let pendingPayload: { requestId: string; action: string } | undefined;
    await second.route(`**/api/sessions/${mockSessionId}/act`, route => {
      pendingPayload = route.request().postDataJSON();
      return route.fulfill({ status: 503, json: { ok: false, code: "FIXTURE_UNAVAILABLE", message: "Тест: незавершённый запрос" } });
    });
    await second.route(`**/api/sessions/${mockSessionId}/requests/*`, route => route.fulfill({ json: { status: "failed", stage: "failed" } }));
    await second.getByRole("button", { name: "Сделать ход", exact: true }).click();
    await expect(second.getByRole("button", { name: "Отложить действие", exact: true })).toBeVisible();
    expect(pendingPayload?.action).toBe("Черновик второй вкладки");
    const pendingBefore = await second.evaluate(id => sessionStorage.getItem(`chronicle:pending:${id}`), mockSessionId);
    expect(JSON.parse(pendingBefore!).id).toBe(pendingPayload?.requestId);
    await expect.poll(() => first.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    const oldAsset = await first.evaluate(async () => {
      for (const script of Array.from(document.querySelectorAll<HTMLScriptElement>('script[src*="/_next/static/"]'))) {
        if ((await (await fetch(script.src)).text()).includes("update-fixture-a")) return script.src;
      }
      throw new Error("Missing build-specific old client chunk");
    });
    const oldScript = await first.evaluate(async url => (await fetch(url)).text(), oldAsset);
    const workerA = await (await fetch(`${base}/sw.js`)).text();
    const shellA = await first.evaluate(async () => (await caches.keys()).filter(name => name.includes("offline")));
    const navigationBefore = [navigationCounts.get(first), navigationCounts.get(second)];
    for (const page of [first, second]) await page.evaluate(() => {
      (window as Window & { workerChanges?: number }).workerChanges = 0;
      navigator.serviceWorker.addEventListener("controllerchange", () => { (window as Window & { workerChanges?: number }).workerChanges!++; });
    });
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
    for (const page of [first, second]) await expect.poll(() => page.evaluate(() => (window as Window & { workerChanges?: number }).workerChanges)).toBeGreaterThan(0);
    expect([navigationCounts.get(first), navigationCounts.get(second)]).toEqual(navigationBefore);
    await expect(composer).toHaveValue(draft);
    expect(await second.evaluate(id => sessionStorage.getItem(`chronicle:pending:${id}`), mockSessionId)).toBe(pendingBefore);
    await second.getByRole("button", { name: "Обновить приложение", exact: true }).click();
    await expect(second.getByRole("status").filter({ hasText: "Дождитесь завершения или восстановления хода" })).toBeVisible();
    expect([navigationCounts.get(first), navigationCounts.get(second)]).toEqual(navigationBefore);
    await second.getByRole("button", { name: "Отложить действие", exact: true }).click();
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
    // These are real Next responses through the cookie-stripping proxy, not API mocks.
    const onlineProbes = await first.evaluate(async campaignId => {
      const probes: { url: string; headers: Record<string, string> }[] = [
        { url: "/api/version", headers: {} },
        { url: `/play/${campaignId}`, headers: {} },
        { url: `/play/${campaignId}?_rsc=p1-private`, headers: { RSC: "1" } },
      ];
      return Promise.all(probes.map(async probe => { const response = await fetch(probe.url, { headers: probe.headers, cache: "no-store" }); await response.text(); return { ...probe, status: response.status, type: response.headers.get("content-type") }; }));
    }, mockSessionId);
    expect(onlineProbes.map(probe => probe.status)).toEqual([200, 200, 200]);
    expect(onlineProbes[1].type).toContain("text/html");
    expect(onlineProbes[2].type).toContain("text/x-component");
    const offlinePage = await context.newPage();
    await setup(offlinePage, "update-fixture-b");
    await context.setOffline(true);
    expect(await first.evaluate(() => navigator.onLine)).toBe(false);
    const offlineProbes = await first.evaluate(async probes => Promise.all(probes.map(async probe => {
      try { await fetch(probe.url, { headers: probe.headers, cache: "no-store" }); return { url: probe.url, rejected: false }; }
      catch { return { url: probe.url, rejected: true }; }
    })), onlineProbes);
    expect(offlineProbes.every(probe => probe.rejected)).toBe(true);
    expect(await second.evaluate(async url => (await fetch(url)).text(), oldAsset)).toBe(oldScript);
    await offlinePage.reload();
    await expect(offlinePage.getByRole("heading", { name: "Нет соединения с миром", exact: true })).toBeVisible();
    await expect(offlinePage.getByRole("status")).toHaveText("Устройство сейчас не в сети.");
    await offlinePage.screenshot({ path: `${output}/offline-public-shell.png` });
    await expect(first.getByRole("textbox", { name: "Ваше действие", exact: true })).toHaveValue("Отложенный черновик после восстановления");
    await context.setOffline(false);
    await expect(offlinePage.getByRole("status")).toHaveText("Устройство видит сеть. Попробуйте снова открыть историю.");
    await offlinePage.getByRole("button", { name: "Повторить", exact: true }).click();
    await expect(offlinePage.locator('meta[name="chronicle-build"]')).toHaveAttribute("content", "update-fixture-b");
    await expect(offlinePage.getByRole("textbox", { name: "Ваше действие", exact: true })).toBeEditable();
    const cacheEntries = await first.evaluate(async () => (await Promise.all((await caches.keys()).map(async name => {
      const cache = await caches.open(name);
      return Promise.all((await cache.keys()).map(async request => ({ cache: name, url: request.url, type: (await cache.match(request))?.headers.get("content-type") })));
    }))).flat());
    const paths = cacheEntries.map(entry => new URL(entry.url).pathname);
    expect(paths.every(path => path.startsWith("/_next/static/") || ["/offline.html", "/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png"].includes(path))).toBe(true);
    expect(cacheEntries.every(entry => !new URL(entry.url).search && (!/text\/(html|x-component)/i.test(entry.type ?? "") || new URL(entry.url).pathname === "/offline.html"))).toBe(true);
    expect(errors).toEqual([]);
    await writeFile(`${output}/result.json`, JSON.stringify({ checks: ["production-build-a-b", "two-tabs-worker-activation-no-navigation", "pending-blocks-update-during-rollout", "unsaved-draft-and-item-binding", "old-chunk-offline", "real-api-html-rsc-not-cached", "public-offline-navigation-online-return", "mobile-width"], onlineProbes, offlineProbes, cacheEntries, pendingPayload, navigationBefore, errors }, null, 2));
    console.log("PASS: two production builds; consistent build IDs; two old tabs; immediate SW activation; preserved old chunks; voluntary one-tab reload; restored draft + exact item binding; mobile; no private caches.");
  } finally { await browser.close(); await stopApp(); proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
