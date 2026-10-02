import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { installUiMock, mockSessionId } from "./ui-mock";

async function main() {
  const base = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3137";
  await mkdir("output/playwright/ui-controls", { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route(`${base}/**`, route => {
      const headers = { ...route.request().headers() };
      delete headers.cookie;
      return route.continue({ headers });
    });
    await installUiMock(page, { admin: true });
    for (const [width, height] of [[1440, 700], [1024, 600], [390, 640]]) {
      await page.context().clearCookies();
      await page.setViewportSize({ width, height });
      await page.goto(`${base}/play/${mockSessionId}`);
      if (width < 781) {
        await page.getByRole("button", { name: "Открыть меню", exact: true }).click();
        await expect(page.locator(".sidebar")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
      }
      const account = page.locator(".sidebar-account");
      const settings = account.getByRole("link", { name: "Настройки", exact: true });
      const profile = account.getByRole("link", { name: "Открыть аккаунт", exact: true });
      await expect(settings).toBeInViewport();
      await expect(profile).toBeInViewport();
      const before = await account.boundingBox();
      await page.locator(".sidebar-scroll").evaluate(node => { node.scrollTop = node.scrollHeight; });
      await expect(settings).toBeInViewport();
      await expect(profile).toBeInViewport();
      expect((await account.boundingBox())?.y).toBe(before?.y);
      await settings.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Настройки пространства", exact: true });
      await expect(dialog).toBeVisible();
      await expect(page).toHaveURL(`${base}/play/${mockSessionId}`);
      await dialog.getByRole("button", { name: "Вернуться в игру", exact: true }).click();
      if (width < 781) {
        await page.getByRole("button", { name: "Открыть меню", exact: true }).click();
        await expect(page.locator(".sidebar")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
      }
      await page.screenshot({ path: `output/playwright/ui-controls/sidebar-${width}.png` });
      if (width < 781) await page.locator(".mobile-shade").click({ position: { x: 350, y: 300 } });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      console.log(`PASS fixed account/settings and keyboard overlay at ${width}x${height}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("tab", { name: "Жизнь", exact: true }).click();
    await expect(page.locator(".lx-life .gx-side-title").first()).toHaveText("Голос рассказчика");
    await page.getByRole("button", { name: "Настроить рассказчика", exact: true }).click();
    const boundaries = page.getByLabel("Чего в истории быть не должно — каждый пункт с новой строки", { exact: true });
    await expect(boundaries).toHaveAttribute("placeholder", "Насилие над животными\nСмерть героя");
    await boundaries.fill("Насилие над животными\nСмерть героя");
    let saved: unknown;
    await page.route(`**/api/sessions/${mockSessionId}`, async route => {
      if (route.request().method() === "PATCH") { saved = route.request().postDataJSON(); await route.fulfill({ json: { ok: true } }); }
      else await route.fallback();
    });
    await page.locator(".lx-life").getByRole("button", { name: "Сохранить", exact: true }).click();
    expect(saved).toMatchObject({ narrator: { boundaries: ["Насилие над животными", "Смерть героя"] } });
    await page.locator(".lx-life").evaluate(node => { let parent: HTMLElement | null = node as HTMLElement; while (parent) { parent.scrollTop = 0; parent = parent.parentElement; } });
    await expect(page.getByRole("button", { name: "Настроить рассказчика", exact: true })).toBeInViewport();
    await page.screenshot({ path: "output/playwright/ui-controls/life.png" });
    expect(errors).toEqual([]);
    console.log("PASS narrator first, explicit multiline boundaries and saved array; no page errors");
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
