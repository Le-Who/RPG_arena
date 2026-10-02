/** Isolated UI regression: API fixtures only, no live database/provider calls. */
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { installUiMock, mockSessionId, mockSnapshot } from "./ui-mock";

async function main() {
  const base = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3137";
  if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname)) throw Error("Loopback fixture server required");
  const output = "output/playwright/revision-210";
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    const goto = async (path: string) => { await page.context().clearCookies(); await page.goto(`${base}${path}`); };
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    // The fixture server uses an unreachable database; no persisted cookie is sent to proxy.
    await page.route(`${base}/**`, route => {
      const headers = { ...route.request().headers() }; delete headers.cookie;
      return route.continue({ headers });
    });
    await installUiMock(page);
    const commitment = { id: "meeting", title: "Чай с Мирой", parties: ["Мира"], place: "Кафе", due: { day: 2, minute: 720 }, status: "accepted", createdTurn: 1, updatedTurn: 1, note: "" };
    await page.route(`**/api/sessions/${mockSessionId}?*`, route => route.fulfill({ json: { ...mockSnapshot, session: { ...mockSnapshot.session, worldState: { ...mockSnapshot.session.worldState, commitments: [commitment] } } } }));
    let sent: Record<string, unknown> | undefined;
    await page.route(`**/api/sessions/${mockSessionId}/commitments`, route => {
      sent = route.request().postDataJSON();
      return route.fulfill({ status: 409, json: { error: "Договорённость уже изменилась — обновите панель" } });
    });
    for (const [width, height] of [[1440, 1000], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await goto("/design");
      await expect(page.getByRole("heading", { name: "Дизайн-система", exact: true })).toBeVisible();
      const recalc = page.getByRole("button", { name: "Пересчитать", exact: true });
      await recalc.focus(); await page.keyboard.press("Enter");
      await expect(page.locator(".x3-tokens small").first()).not.toHaveText("—");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: `${output}/design-${width}.png`, fullPage: true });

      await goto(`/play/${mockSessionId}`);
      await page.getByRole("textbox", { name: "Ваше действие", exact: true }).waitFor();
      await page.keyboard.press("Control+k");
      const palette = page.getByRole("dialog", { name: "Командная палитра", exact: true });
      await palette.getByRole("combobox").fill("ход 1");
      await expect(palette.getByRole("option", { name: /Перейти к ходу 1/ })).toBeVisible();
      await palette.getByRole("combobox").press("Enter");
      await expect(palette).toHaveCount(0);
      await page.getByRole("tab", { name: "Жизнь", exact: true }).click();
      const controls = page.getByRole("group", { name: "Исход договорённости «Чай с Мирой»", exact: true });
      await controls.getByRole("button", { name: "Перенести", exact: true }).focus();
      await page.keyboard.press("Enter");
      await controls.getByLabel("День", { exact: true }).fill("3");
      await controls.getByLabel("Время", { exact: true }).fill("13:30");
      await controls.getByRole("button", { name: "Сохранить срок", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(controls.getByRole("alert")).toContainText("уже изменилась");
      expect(sent?.action).toBe("reschedule"); expect(sent?.day).toBe(3); expect(sent?.version).toMatch(/^[a-f0-9]{64}$/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: `${output}/commitments-${width}.png`, fullPage: true });
      console.log(`PASS design, turn query and commitment keyboard/stale state ${width}x${height}`);
    }
    await goto("/offline.html");
    await expect(page.getByRole("heading", { name: "Нет соединения с миром" })).toBeVisible();
    await page.getByRole("button", { name: "Повторить" }).focus();
    await expect(page.getByRole("button", { name: "Повторить" })).toBeFocused();
    await page.screenshot({ path: `${output}/offline-mobile.png` });
    expect(errors).toEqual([]);
    // Exercise the actual worker in a fresh storage context, independent of registration's production gate.
    const offlineContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const offlinePage = await offlineContext.newPage();
      await offlinePage.goto(`${base}/offline.html`);
      await offlinePage.evaluate(async () => {
        await navigator.serviceWorker.register("/sw.js");
        await navigator.serviceWorker.ready;
      });
      await expect.poll(() => offlinePage.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
      await offlineContext.setOffline(true);
      await offlinePage.goto(`${base}/play/private-fixture`);
      await expect(offlinePage.getByRole("heading", { name: "Нет соединения с миром" })).toBeVisible();
      const paths = await offlinePage.evaluate(async () => (await Promise.all((await caches.keys()).map(async name => (await (await caches.open(name)).keys()).map(r => new URL(r.url).pathname)))).flat());
      expect(paths).toContain("/offline.html");
      expect(paths.every(path => path === "/offline.html" || path === "/icon.svg" || path.startsWith("/icons/"))).toBe(true);
      console.log("PASS actual service worker installation and offline navigation; no private cache entries");
    } finally { await offlineContext.close(); }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
