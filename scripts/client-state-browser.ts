/** Client request-order regressions with synthetic HTTP fixtures; no database or providers. */
import { chromium, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { installUiMock, mockSession, mockSessionId, mockSnapshot, settings } from "./ui-mock";

const base = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3197";
const output = "output/playwright/client-state";
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

async function readingRace(page: Page) {
  await installUiMock(page);
  const first = deferred(), second = deferred();
  let writes = 0;
  await page.route("**/api/workspace", async route => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const patch = route.request().postDataJSON();
    if (!patch.reading) throw new Error("Unexpected workspace mutation");
    const number = ++writes;
    if (number === 1) { await first.promise; return route.fulfill({ status: 503, json: { message: "Первая настройка не сохранена" } }); }
    await second.promise;
    return route.fulfill({ json: { ok: true } });
  });
  try {
    await page.goto(`${base}/settings`);
    const reading = page.locator("#reading");
    const sepia = reading.getByRole("button", { name: /Сепия/ });
    const contrast = reading.getByRole("button", { name: /Контраст/ });
    await sepia.focus(); await page.keyboard.press("Enter");
    await expect.poll(() => writes).toBe(1);
    await contrast.focus(); await page.keyboard.press("Enter");
    await expect(contrast).toHaveAttribute("aria-pressed", "true");
    const failed = page.waitForResponse(response => response.url().endsWith("/api/workspace") && response.status() === 503);
    first.resolve(); await failed;
    await expect.poll(() => writes).toBe(2);
    // An older failed write must leave the newest optimistic selection intact.
    await expect(contrast).toHaveAttribute("aria-pressed", "true");
    second.resolve();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "contrast");
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("chronicle:reading:v1")!).theme)).toBe("contrast");
    await page.screenshot({ path: `${output}/reading-${page.viewportSize()!.width}.png` });
  } finally { first.resolve(); second.resolve(); }
}

async function workspaceRollback(page: Page) {
  await installUiMock(page);
  const favorite = deferred();
  let favoriteStarted = false;
  await page.route("**/api/workspace", async route => {
    const patch = route.request().postDataJSON();
    if (patch.favorites) {
      favoriteStarted = true; await favorite.promise;
      return route.fulfill({ status: 503, json: { message: "Избранное не сохранено" } });
    }
    expect(patch.reading.theme).toBe("sepia");
    return route.fulfill({ json: { ok: true } });
  });
  try {
    await page.goto(`${base}/`);
    const bookmark = page.getByRole("button", { name: "Убрать Пепельная Корона из избранного", exact: true });
    await bookmark.focus(); await page.keyboard.press("Enter");
    await expect.poll(() => favoriteStarted).toBe(true);
    // Client navigation keeps the independent favorite request in flight.
    if (page.viewportSize()!.width < 781) await page.getByRole("button", { name: "Открыть меню", exact: true }).click();
    await page.getByRole("link", { name: "Настройки", exact: true }).click();
    const sepia = page.locator("#reading").getByRole("button", { name: /Сепия/ });
    const saved = page.waitForResponse(response => response.url().endsWith("/api/workspace") && response.status() === 200);
    await sepia.focus(); await page.keyboard.press("Enter"); await saved;
    const failed = page.waitForResponse(response => response.url().endsWith("/api/workspace") && response.status() === 503);
    favorite.resolve(); await failed;
    await expect(page.getByText("Избранное не сохранено", { exact: true })).toBeVisible();
    await expect(sepia).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "sepia");
  } finally { favorite.resolve(); }
}

async function bootstrapRace(page: Page) {
  await installUiMock(page);
  const refresh = deferred();
  let bootstraps = 0;
  await page.route("**/api/bootstrap", async route => {
    if (++bootstraps > 1) await refresh.promise;
    return route.fallback();
  });
  await page.route("**/api/workspace", route => route.fulfill({ json: { ok: true } }));
  try {
    await page.goto(`${base}/settings`);
    const sepia = page.locator("#reading").getByRole("button", { name: /Сепия/ });
    await expect(sepia).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => bootstraps).toBe(2);
    const saved = page.waitForResponse(response => response.url().endsWith("/api/workspace"));
    await sepia.focus(); await page.keyboard.press("Enter"); await saved;
    const refreshed = page.waitForResponse(response => response.url().endsWith("/api/bootstrap"));
    refresh.resolve(); await refreshed;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(sepia).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("chronicle:reading:v1")!).theme)).toBe("sepia");
  } finally { refresh.resolve(); }
}

async function calmScrolling(page: Page) {
  await installUiMock(page);
  let calm = true;
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    ok: true,
    identity: { kind: "guest", profileId: mockSession.ownerId, account: null, guestProfileId: mockSession.ownerId, isAdmin: false, capabilities: { administration: false }, pendingGuestCampaigns: 0, passwordRecoveryAvailable: false },
    sessions: [mockSession], settings,
    workspace: { id: mockSession.ownerId, displayName: "Искатель историй", favorites: [], reading: { textScale: "normal", measure: "normal", theme: "midnight", motion: calm ? "reduced" : "full" } },
  } }));
  await page.route(`**/api/sessions/${mockSessionId}/recap`, route => route.fulfill({ json: { recap: { headline: "Ранее в истории", sections: [], markdown: "Печать настоящая." } } }));
  await page.addInitScript(() => {
    const observed = window as Window & { scrollRequests?: { id: string; behavior?: ScrollBehavior }[] };
    const requests: { id: string; behavior?: ScrollBehavior }[] = [];
    observed.scrollRequests = requests;
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function(options) {
      requests.push({ id: this.id, behavior: typeof options === "object" ? options.behavior : undefined });
      return original.call(this, options);
    };
  });
  for (const osPreference of [false, true]) {
    calm = !osPreference;
    await page.emulateMedia({ reducedMotion: osPreference ? "reduce" : "no-preference" });
    await page.goto(`${base}/play/${mockSessionId}`);
    await expect(page.getByRole("textbox", { name: "Ваше действие", exact: true })).toBeEditable();
    // Both the profile setting and the OS preference cover native anchor scrolling.
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe("auto");
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "Поиск миров, историй и команд" }).fill("Ранее в истории");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => (window as Window & { scrollRequests?: { id: string; behavior?: ScrollBehavior }[] }).scrollRequests?.filter(call => call.id === "recap-title").at(-1)?.behavior)).toBe("instant");
  }
}

async function recordRace(page: Page) {
  await installUiMock(page);
  const otherId = "00000000-0000-4000-8000-000000000002";
  const otherSession = { ...mockSession, id: otherId, title: "Вторая история" };
  await page.route("**/api/bootstrap", async route => {
    // Complete public bootstrap identity, independent of server credentials.
    await route.fulfill({ json: {
      ok: true,
      identity: { kind: "guest", profileId: mockSession.ownerId, account: null, guestProfileId: mockSession.ownerId, isAdmin: false, capabilities: { administration: false }, pendingGuestCampaigns: 0, passwordRecoveryAvailable: false },
      sessions: [mockSession, otherSession],
      settings,
      workspace: { id: mockSession.ownerId, displayName: "Искатель историй", favorites: [], reading: { textScale: "normal", measure: "normal", theme: "midnight", motion: "full" } },
    } });
  });
  const retry = deferred();
  let attempts = 0;
  await page.route(`**/api/sessions/${mockSessionId}`, async route => {
    if (++attempts === 1) return route.fulfill({ status: 503, json: { message: "Первая история временно недоступна" } });
    await retry.promise;
    return route.fulfill({ json: mockSnapshot });
  });
  await page.route(`**/api/sessions/${otherId}`, route => route.fulfill({ json: {
    ...mockSnapshot, session: otherSession,
    memories: [{ ...mockSnapshot.memories[0], id: "other-memory", sessionId: otherId, title: "Память второй истории" }],
  } }));
  try {
    await page.goto(`${base}/memory`);
    await expect(page.getByText("Первая история временно недоступна", { exact: true })).toBeVisible();
    await page.locator(".records").getByRole("button", { name: "Повторить", exact: true }).click();
    await expect.poll(() => attempts).toBe(2);
    await page.getByRole("combobox", { name: "Выбрать кампанию" }).selectOption(otherId);
    await expect(page.getByRole("heading", { name: "Память второй истории", exact: true })).toBeVisible();
    const late = page.waitForResponse(response => new URL(response.url()).pathname === `/api/sessions/${mockSessionId}` && response.status() === 200);
    retry.resolve(); await late;
    // Flush promise callbacks and a paint before asserting the retained campaign.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole("heading", { name: "Память второй истории", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Печать Хранителей", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "К исходному ходу", exact: true })).toHaveAttribute("href", `/play/${otherId}#turn-3`);
    await page.screenshot({ path: `${output}/memory-${page.viewportSize()!.width}.png` });
  } finally { retry.resolve(); }
}

async function main() {
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const width of [1440, 390]) {
      for (const [name, run] of [["reading", readingRace], ["records", recordRace], ["workspace", workspaceRollback], ["bootstrap", bootstrapRace], ["motion", calmScrolling]] as const) {
        if (process.env.CLIENT_STATE_CASE && process.env.CLIENT_STATE_CASE !== name) continue;
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        try { await run(page); expect(errors).toEqual([]); console.log(`PASS ${name} request race at ${width}px`); }
        finally { await page.close(); }
      }
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
