import { chromium, expect } from "@playwright/test";
import { installUiMock, mockSessionId } from "./ui-mock";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

async function main() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await installUiMock(page);
    await page.goto(`${process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3137"}/play/${mockSessionId}`);
    const input = page.locator("#action-input");
    await input.fill("Мой несохранённый замысел");
    await page.getByRole("tab", { name: "Вещи", exact: true }).click();
    await page.getByRole("button", { name: "Добавить в действие" }).first().click();
    await expect(input).toHaveValue(/^Мой несохранённый замысел\nИспользовать «.+»: $/);
    await page.getByRole("button", { name: "Действия: Короткий лук", exact: true }).click();
    await page.getByRole("menuitem", { name: "Осмотреть", exact: true }).click();
    await expect(input).toHaveValue("Мой несохранённый замысел\nИспользовать «Карта побережья»: \nОсмотреть «Короткий лук»");
    await input.fill("Я говорю с Ма и жду ответа");
    await input.press("Home");
    for (let index = 0; index < 13; index++) await input.press("ArrowRight");
    await expect(page.getByRole("option", { name: /Мара/ })).toBeVisible();
    await mkdir("output/ui-audit", { recursive: true });
    await page.screenshot({ path: "output/ui-audit/action-composer-desktop.png", fullPage: true });
    await input.press("ArrowDown");
    await input.press("Enter");
    await expect(input).toHaveValue("Я говорю с «Мара» и жду ответа");
    await input.fill("Я говорю с Ма");
    await expect(page.getByRole("option", { name: /Мара/ })).toBeVisible();
    await input.press("Escape");
    await expect(page.getByRole("listbox", { name: "Имена и предметы мира" })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await input.fill("Иду на Пеп");
    await expect(page.getByRole("option", { name: /Пепельный тракт/ })).toBeVisible();
    await page.screenshot({ path: "output/ui-audit/action-composer-mobile.png", fullPage: true });
    await page.getByRole("option", { name: /Пепельный тракт/ }).click();
    await expect(input).toHaveValue("Иду на «Пепельный тракт»");
    await input.fill("Использовать Кар");
    await page.getByRole("option", { name: /Карта побережья/ }).click();
    await expect(input).toHaveValue("Использовать «Карта побережья»");
    await input.press("End");
    await input.press("Space");
    await input.press("a");
    await page.getByRole("button", { name: "Добавить в действие" }).nth(1).click();
    await expect(input).toHaveValue("Использовать «Карта побережья» a\nИспользовать «Короткий лук»: ");
    const sent = page.waitForRequest(request => request.url().endsWith(`/api/sessions/${mockSessionId}/act`) && request.method() === "POST");
    await input.press("Control+Enter");
    const payload = (await sent).postDataJSON();
    assert.deepEqual(payload.itemIds, ["40000000-0000-4000-8000-000000000001", "40000000-0000-4000-8000-000000000002"]);
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error("Composer causes mobile horizontal overflow");
    if (errors.length) throw new Error(errors.join("\n"));
    console.log("PASS: ready phrase draft preservation; contextual entity completion, keyboard dismissal, mobile click (isolated mock API)");
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
