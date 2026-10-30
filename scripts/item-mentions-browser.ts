/** Browser regression checks against synthetic APIs; no provider or real database access. */
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { installUiMock, mockSessionId, mockSnapshot } from "./ui-mock";

async function main() {
  const base = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3043";
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname)) throw new Error("Loopback only");
  const output = "output/playwright/item-mentions";
  await mkdir(output, { recursive: true });
  const item = { ...mockSnapshot.inventory[0], name: "разных цветов трусики", quantity: 2 };
  const snapshot = { ...mockSnapshot, inventory: [item, mockSnapshot.inventory[1], { ...item, id: "40000000-0000-4000-8000-000000000003", name: "Закончились", quantity: 0 }] };
  const browser = await chromium.launch();
  try {
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width === 390 });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await installUiMock(page);
      await page.route(url => url.searchParams.has("_rsc"), route => route.abort());
      await page.route(`**/api/sessions/${mockSessionId}?*`, route => route.fulfill({ json: snapshot }));
      const payloads: { action: string; itemIds: string[] }[] = [];
      await page.route("**/act", async route => {
        payloads.push(route.request().postDataJSON());
        await route.fulfill({ status: 502, json: { code: "AI_FAILED", message: "Synthetic failure preserves the draft" } });
      });
      await page.route("**/requests/*", route => route.fulfill({ json: { requestId: route.request().url().split("/").at(-1), status: "not_accepted" } }));
      await page.goto(`${base}/play/${mockSessionId}`);
      const input = page.locator("#action-input");
      await expect(input).toBeVisible();
      await input.fill("@несуществующий");
      await expect(page.getByRole("status").filter({ hasText: "Предмет не найден" })).toBeVisible();
      await input.press("Escape");
      await expect(page.getByText("Предмет не найден", { exact: false })).toHaveCount(0);
      await input.fill("Показываю @");
      await expect(page.getByRole("option")).toHaveCount(2);
      await page.screenshot({ path: `${output}/inventory-${width}.png`, fullPage: true });
      await input.press("ArrowDown");
      await expect(page.getByRole("option", { selected: true })).toContainText("Короткий лук");
      await input.press("ArrowUp");
      await input.press("Enter");
      await expect(input).toHaveValue("Показываю «разных цветов трусики»");
      await expect(input).toBeFocused();
      expect(payloads).toHaveLength(0);
      await input.fill("Я беру трусы");
      await expect(page.getByRole("option")).toHaveCount(1);
      if (width === 390) await page.getByRole("option").tap();
      else await page.getByRole("option").click();
      await expect(input).toHaveValue("Я беру «разных цветов трусики»");
      await input.press("Control+Enter");
      await expect.poll(() => payloads.length).toBe(1);
      expect(payloads[0].itemIds).toEqual([item.id]);
      expect(payloads[0].action).toBe("Я беру «разных цветов трусики»");
      await expect(input).toBeEnabled();
      await expect(page.locator('.gx-recovery[role="alert"]')).toContainText("Synthetic failure preserves the draft");
      await expect(page.locator('.gx-recovery[role="alert"]').getByRole("button", { name: "Повторить безопасно" })).toBeVisible();
      await expect(page.locator(".gx-error")).toHaveCount(0);
      await page.screenshot({ path: `${output}/recovery-${width}.png` });
      await page.getByRole("button", { name: "Отложить действие", exact: true }).click();
      await input.fill("Я беру «другие вещи»");
      await input.press("Control+Enter");
      await expect.poll(() => payloads.length).toBe(2);
      expect(payloads[1].itemIds ?? []).toEqual([]);
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await context.close();
      console.log(`PASS inventory @, noun matching, keyboard/touch selection, exact identity and edited binding removal at ${width}px`);
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
