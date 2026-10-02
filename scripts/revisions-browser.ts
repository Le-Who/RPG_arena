/** Real HTTP/DB regression. Run ONLY against an explicitly disposable local application. */
import { chromium, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";

async function main() {
  const base = new URL(process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3130");
  if (process.env.CHRONICLE_UI_ISOLATED !== "1" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) throw new Error("Requires CHRONICLE_UI_ISOLATED=1 and a disposable loopback server/database, with no provider credentials.");
  const output = "output/playwright/revisions";
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(30000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const login = `ui_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const password = `test-only-${randomUUID()}`;
  const goto = (path: string) => page.goto(new URL(path, base).href);
  // Browser fetch honors Chromium's secure loopback-cookie policy; APIRequestContext does not.
  const identity = () => page.evaluate(async () => (await (await fetch("/api/auth/me")).json()).identity);
  const sessions = () => page.evaluate(async () => (await (await fetch("/api/sessions")).json()).sessions as { id: string }[]);
  async function createStory() {
    await goto("/campaigns");
    await page.getByRole("button", { name: "Новая кампания", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Начать историю", exact: true }).click();
    await page.waitForURL("**/play/**");
    await page.getByRole("textbox", { name: "Ваше действие", exact: true }).waitFor();
    return new URL(page.url()).pathname.split("/").at(-1)!;
  }
  async function loginExisting() {
    await page.getByRole("button", { name: "Уже есть аккаунт", exact: true }).click();
    await page.getByRole("textbox", { name: "Логин", exact: true }).fill(login);
    await page.getByLabel("Пароль", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await page.getByRole("button", { name: "Выйти", exact: true }).waitFor();
  }
  try {
    await goto("/settings");
    await page.getByRole("button", { name: "Создать аккаунт", exact: true }).waitFor();
    await expect(page.getByRole("button", { name: "Для разработки", exact: true })).toHaveCount(0);
    const config = await page.evaluate(async () => (await (await fetch("/api/settings")).json()));
    if (config.keysCount || config.envKeysCount || config.useLiveAI) throw Error("Fixture must not have live provider credentials");
    const guest = await identity();
    const original = await createStory();
    await goto("/settings");
    await page.getByRole("textbox", { name: "Логин", exact: true }).fill(login);
    await page.getByLabel("Пароль", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Создать аккаунт", exact: true }).click();
    await page.getByRole("button", { name: "Выйти", exact: true }).waitFor();
    expect((await identity()).profileId).toBe(guest.profileId);
    expect((await sessions()).map(row => row.id)).toContain(original);
    await page.getByRole("button", { name: "Выйти", exact: true }).click();
    await page.getByRole("button", { name: "Создать аккаунт", exact: true }).waitFor();
    expect(await sessions()).toHaveLength(0);
    expect((await identity()).profileId).not.toBe(guest.profileId);
    const laterGuest = await createStory();
    await goto("/settings");
    await loginExisting();
    expect((await sessions()).map(row => row.id)).not.toContain(laterGuest);
    await page.getByRole("button", { name: "Перенести гостевые кампании", exact: true }).click();
    await page.getByRole("button", { name: "Подтвердить перенос", exact: true }).click();
    await expect(page.getByRole("button", { name: "Подтвердить перенос", exact: true })).toHaveCount(0);
    expect((await sessions()).map(row => row.id)).toContain(laterGuest);
    expect(await page.evaluate(async () => (await fetch("/api/system/status")).status)).toBe(403);
    expect(await page.evaluate(async () => (await fetch("/system")).status)).toBe(404);
    await expect(page.getByRole("button", { name: "Для разработки", exact: true })).toHaveCount(0);

    await goto(`/play/${original}`);
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("link", { name: "Скачать кампанию JSON", exact: true }).click();
    await (await downloadEvent).saveAs(`${output}/campaign.json`);
    await goto("/campaigns");
    await page.getByRole("button", { name: "Импорт кампании", exact: true }).click();
    let dialog = page.getByRole("dialog");
    for (const [name, width, height] of [["desktop", 1280, 900], ["mobile", 390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await page.screenshot({ path: `${output}/import-${name}.png` });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await dialog.locator('input[type="file"]').setInputFiles(`${output}/campaign.json`);
    await dialog.getByRole("button", { name: "Импортировать", exact: true }).click();
    await page.waitForURL("**/play/**");
    expect(new URL(page.url()).pathname).not.toBe(`/play/${original}`);
    await page.getByRole("textbox", { name: "Ваше действие", exact: true }).waitFor();
    await page.locator(".toast").waitFor({ state: "hidden" });

    await page.keyboard.press("Control+k");
    dialog = page.getByRole("dialog", { name: "Командная палитра", exact: true });
    for (const [name, width, height] of [["desktop", 1280, 900], ["mobile", 390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await page.screenshot({ path: `${output}/commands-${name}.png` });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await dialog.getByRole("combobox").fill("Пульс");
    await dialog.getByRole("status").waitFor();
    await expect(dialog.getByRole("option")).toHaveCount(0);
    await dialog.getByRole("combobox").fill("контрольные точки");
    await dialog.getByRole("option").waitFor();
    await dialog.getByRole("combobox").press("Enter");
    dialog = page.getByRole("dialog", { name: "Развилки истории", exact: true });
    await dialog.getByRole("button", { name: "Сохранить точку", exact: true }).waitFor();
    await page.keyboard.press("Escape");

    // Exercise distinct modal layouts at both widths, with bounded geometry and keyboard focus.
    for (const [name, width, height] of [["desktop", 1280, 900], ["mobile", 390, 844]] as const) {
      await page.setViewportSize({ width, height });
      for (const [button, file] of [["Как это работает", "guide"], ["Обновления движка", "updates"], ["Развилки истории", "checkpoints"]]) {
        await page.getByRole("button", { name: button, exact: true }).click();
        dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        if (file === "checkpoints") await dialog.locator(".checkpoint-loading").waitFor({ state: "hidden" });
        expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
        await page.keyboard.press("Tab");
        expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
        await page.screenshot({ path: `${output}/${file}-${name}.png` });
        await page.keyboard.press("Escape");
      }
      await page.getByRole("tab", { name: "Мир", exact: true }).click();
      await page.getByRole("button", { name: "Открыть карту крупно", exact: true }).click();
      dialog = page.getByRole("dialog", { name: "Карта мира", exact: true });
      expect(await dialog.evaluate(el => el.parentElement!.contains(document.elementFromPoint(5, 100)))).toBe(true);
      await page.screenshot({ path: `${output}/map-${name}.png` });
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "Открыть карту крупно", exact: true })).toBeFocused();
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "Создать свой мир", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Новая история", exact: true });
    await dialog.getByRole("textbox", { name: "Название истории *", exact: true }).fill("Черновик остаётся");
    for (const [name, width, height] of [["desktop", 1280, 900], ["mobile", 390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await page.screenshot({ path: `${output}/creator-${name}.png` });
    }
    await dialog.getByRole("button", { name: "Заполнить пустые поля", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Настройки пространства", exact: true });
    await settings.getByRole("textbox", { name: "Имя профиля", exact: true }).waitFor();
    for (const [name, width, height] of [["desktop", 1280, 900], ["mobile", 390, 844], ["200-layout", 640, 450]] as const) {
      await page.setViewportSize({ width, height });
      expect(await settings.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: `${output}/settings-${name}.png` });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
    expect(await settings.locator(".dialog-body").evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: `${output}/settings-200-text.png` });
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    await settings.getByRole("textbox", { name: "Имя профиля", exact: true }).fill("Несохранённое имя");
    await page.keyboard.press("Escape");
    await settings.getByRole("button", { name: "Продолжить редактирование", exact: true }).click();
    await expect(settings.getByRole("textbox", { name: "Имя профиля", exact: true })).toHaveValue("Несохранённое имя");
    await page.keyboard.press("Escape");
    await settings.getByRole("button", { name: "Отбросить и вернуться", exact: true }).click();
    await expect(dialog.getByRole("textbox", { name: "Название истории *", exact: true })).toHaveValue("Черновик остаётся");
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
    console.log("PASS: guest/register/logout/login/adopt, role boundary, JSON round-trip, context commands, modal geometry/focus and nested dirty form. Fixtures retained only in the disposable DB.");
  } finally { await context.close(); await browser.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Browser regression failed"); process.exitCode = 1; });
