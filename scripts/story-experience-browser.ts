import { chromium, expect } from "@playwright/test";
import { installUiMock, mockSessionId, mockSnapshot, settings as mockSettings } from "./ui-mock";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";

async function main() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await installUiMock(page);
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    const base = process.env.SMOKE_BASE_URL ?? "http://localhost:3010";
    await page.goto(`${base}/play/${mockSessionId}`);
    await expect(page.getByRole("button", { name: "Скрыть меню", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Скрыть меню", exact: true }).click();
    await expect(page.locator(".sidebar")).toBeHidden();
    await page.getByRole("button", { name: "Открыть меню", exact: true }).click();
    await expect(page.locator(".sidebar")).toBeVisible();
    await page.locator("#action-input").fill("Выйти на Пепельный тракт");
    await expect(page.getByText("Предложенное действие", { exact: true })).toBeVisible();
    await page.locator("#action-input").fill("Мой несохранённый замысел");
    await expect(page.getByText("Свободное действие", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Мир", exact: true }).click();
    await page.getByRole("button", { name: "Режим чтения", exact: true }).click();
    await page.locator(".bottom-settings").click();
    const settings = page.getByRole("dialog", { name: "Настройки пространства", exact: true });
    await expect(settings).toBeVisible();
    await expect(page).toHaveURL(`${base}/play/${mockSessionId}`);
    await page.keyboard.press("1");
    await settings.getByRole("button", { name: "Вернуться в игру", exact: true }).click();
    await expect(settings).toHaveCount(0);
    await expect(page.locator("#action-input")).toHaveValue("Мой несохранённый замысел");
    await expect(page.getByRole("button", { name: "Выйти из режима чтения" })).toBeVisible();
    await page.locator(".bottom-settings").click();
    await settings.getByLabel("API-ключ Gemini", { exact: true }).fill("unsaved-test-key");
    await settings.getByRole("button", { name: "Вернуться в игру", exact: true }).click();
    await expect(settings.getByText("Есть несохранённые изменения", { exact: true })).toBeVisible();
    await settings.getByRole("button", { name: "Продолжить редактирование" }).click();
    await expect(settings.getByLabel("API-ключ Gemini", { exact: true })).toHaveValue("unsaved-test-key");
    await settings.getByRole("button", { name: "Вернуться в игру", exact: true }).click();
    await settings.getByRole("button", { name: "Отбросить и вернуться" }).click();
    await page.getByRole("button", { name: "Выйти из режима чтения" }).click();
    await expect(page.getByRole("tab", { name: "Мир", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "Режим чтения", exact: true }).click();
    await page.locator("#action-input").scrollIntoViewIfNeeded();
    const reading = page.getByRole("button", { name: "Выйти из режима чтения" });
    const box = await reading.boundingBox();
    const header = await page.locator(".topbar").boundingBox();
    if (!box || !header || box.y < header.y + header.height) throw new Error("Reading control overlaps app header");
    for (const width of [390, 720]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(reading).toBeInViewport();
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error(`Overflow at ${width}`);
    }
    await mkdir("output/playwright", { recursive: true });
    await page.screenshot({ path: "output/playwright/story-experience-mobile.png", fullPage: true, animations: "disabled" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Создать свой мир", exact: true }).click();
    const creator = page.getByRole("dialog", { name: "Новая история", exact: true });
    await creator.getByLabel("Название истории").fill("Мой бережно сохранённый мир");
    await creator.getByLabel("Завязка истории").fill("История о возвращении домой после долгого путешествия.");
    await expect(creator.getByLabel("Тон повествования")).toHaveValue("");
    await creator.getByRole("button", { name: "Далее: герой и правила" }).click();
    await expect(creator.getByLabel("Роль", { exact: true })).toHaveValue("");
    await creator.getByLabel("Имя героя").fill("Вера");
    await creator.getByRole("button", { name: "Заполнить пустые поля" }).click();
    await expect(settings).toBeVisible();
    await expect(creator).toBeHidden();
    await settings.getByRole("button", { name: "Вернуться к истории" }).click();
    await expect(creator.getByLabel("Имя героя")).toHaveValue("Вера");
    await creator.getByRole("button", { name: "Назад к миру" }).click();
    await expect(creator.getByLabel("Название истории")).toHaveValue("Мой бережно сохранённый мир");
    await creator.getByRole("button", { name: "Закрыть", exact: true }).click();
    await page.locator(".bottom-settings").click();
    await settings.getByRole("button", { name: "Для разработки", exact: true }).click();
    await expect(settings.getByRole("switch", { name: "Теневой пилот TypeSafe" })).toHaveAttribute("aria-checked", "false");
    await settings.getByRole("button", { name: "Назад к настройкам" }).click();
    await settings.getByRole("button", { name: "Вернуться в игру" }).click();

    const overlayHistoryPage = await browser.newPage();
    await installUiMock(overlayHistoryPage);
    await overlayHistoryPage.goto(`${base}/play/${mockSessionId}`);
    await overlayHistoryPage.locator("#action-input").fill("Замысел остаётся в игре");
    await overlayHistoryPage.locator(".bottom-settings").click();
    const overlaySettings = overlayHistoryPage.getByRole("dialog", { name: "Настройки пространства", exact: true });
    await expect(overlaySettings).toBeVisible();
    await overlayHistoryPage.evaluate(() => history.back());
    await expect(overlaySettings).toHaveCount(0);
    await expect(overlayHistoryPage).toHaveURL(`${base}/play/${mockSessionId}`);
    await expect(overlayHistoryPage.locator("#action-input")).toHaveValue("Замысел остаётся в игре");
    await expect.poll(() => overlayHistoryPage.evaluate(() => Boolean(history.state?.chronicleSettingsOverlay || history.state?.chronicleDirtyGuard))).toBe(false);
    await overlayHistoryPage.locator(".bottom-settings").click();
    await overlaySettings.getByLabel("API-ключ Gemini", { exact: true }).fill("overlay-dirty-key");
    await overlayHistoryPage.evaluate(() => history.back());
    await expect(overlaySettings.getByText("Есть несохранённые изменения", { exact: true })).toBeVisible();
    await overlaySettings.getByRole("button", { name: "Отбросить и вернуться" }).click();
    await expect(overlaySettings).toHaveCount(0);
    await expect(overlayHistoryPage).toHaveURL(`${base}/play/${mockSessionId}`);
    await expect(overlayHistoryPage.locator("#action-input")).toHaveValue("Замысел остаётся в игре");
    await expect.poll(() => overlayHistoryPage.evaluate(() => Boolean(history.state?.chronicleSettingsOverlay || history.state?.chronicleDirtyGuard))).toBe(false);
    await overlayHistoryPage.locator(".bottom-settings").click();
    await overlaySettings.getByLabel("API-ключ Gemini", { exact: true }).fill("overlay-save-key");
    await overlayHistoryPage.evaluate(() => history.back());
    await overlaySettings.getByRole("button", { name: "Сохранить и вернуться" }).click();
    await expect(overlaySettings).toHaveCount(0);
    await expect(overlayHistoryPage).toHaveURL(`${base}/play/${mockSessionId}`);
    await expect(overlayHistoryPage.locator("#action-input")).toHaveValue("Замысел остаётся в игре");
    await expect.poll(() => overlayHistoryPage.evaluate(() => Boolean(history.state?.chronicleSettingsOverlay || history.state?.chronicleDirtyGuard))).toBe(false);
    await overlayHistoryPage.close();

    const typeSafePage = await browser.newPage();
    await installUiMock(typeSafePage);
    await typeSafePage.route("**/api/developer/typesafe/results", route => route.fulfill({ json: { results: [{ id: "malformed", campaignTitle: "Сбой", turnNumber: 1, report: null, completedAt: new Date().toISOString() }] } }));
    let removeStarted = false;
    let finishRemove!: () => void;
    await typeSafePage.route("**/api/developer/typesafe", async route => {
      if (route.request().method() === "POST") await new Promise<void>(resolve => { removeStarted = true; finishRemove = resolve; });
      await route.fulfill({ json: route.request().method() === "POST"
        ? { configured: false, storedConfigured: false, maskedKey: null, source: "none", envOverride: false, pilotEnabled: false, model: "jev-1.13.0" }
        : { configured: true, storedConfigured: true, maskedKey: "••••1234", source: "stored", envOverride: false, pilotEnabled: false, model: "jev-1.13.0" } });
    });
    await typeSafePage.goto(`${base}/settings`);
    await typeSafePage.getByRole("button", { name: "Для разработки", exact: true }).click();
    await expect(typeSafePage.getByText("Результатов пока нет.", { exact: true })).toBeVisible();
    await typeSafePage.getByRole("switch", { name: "Теневой пилот TypeSafe" }).click();
    await typeSafePage.getByRole("button", { name: "Удалить сохранённый ключ TypeSafe" }).click();
    await expect.poll(() => removeStarted).toBe(true);
    await typeSafePage.getByLabel("API-ключ TypeSafe", { exact: true }).fill("replacement-key-during-delete");
    finishRemove();
    await expect(typeSafePage.getByRole("switch", { name: "Теневой пилот TypeSafe" })).toHaveAttribute("aria-checked", "true");
    await expect(typeSafePage.getByLabel("API-ключ TypeSafe", { exact: true })).toHaveValue("replacement-key-during-delete");
    await typeSafePage.close();

    const formPage = await browser.newPage();
    await installUiMock(formPage);
    await formPage.route("**/api/settings", route => route.fulfill({ json: { ...mockSettings, useLiveAI: true, keysCount: 1 } }));
    let generationCalls = 0;
    let release!: () => void;
    await formPage.route("**/api/story-drafts/autofill", async route => {
      generationCalls++;
      if (generationCalls === 2) await new Promise<void>(resolve => { release = resolve; });
      await route.fulfill({ json: { patch: { title: "Новый мир", pitch: "Возвращение путешественника в изменившийся мир.", tone: "Тёплый", name: "Вера", archetype: "Путешественница" }, modelUsed: "gemini-3.5-flash-lite" } }).catch(() => {});
    });
    await formPage.goto(base);
    await formPage.getByRole("button", { name: "Создать свой мир", exact: true }).click();
    const draft = formPage.getByRole("dialog", { name: "Новая история" });
    await draft.getByRole("button", { name: "Заполнить пустые поля" }).click();
    await expect(draft.getByLabel("Название истории")).toHaveValue("Новый мир");
    await draft.getByRole("button", { name: "Далее: герой и правила" }).click();
    await expect(draft.getByLabel("Имя героя")).toHaveValue("Вера");
    await draft.getByLabel("Навыки, через запятую").fill("а,б,в,г,д,е,ж");
    await draft.getByRole("button", { name: "Начать историю" }).click();
    assert.equal(await draft.getByLabel("Навыки, через запятую").evaluate(node => (node as HTMLInputElement).validity.valid), false);
    await draft.getByRole("button", { name: "Заполнить пустые поля" }).click();
    await expect.poll(() => generationCalls).toBe(2);
    await draft.getByLabel("Имя героя").fill("Моё изменение");
    release();
    await expect(draft.getByLabel("Имя героя")).toHaveValue("Моё изменение");
    await formPage.close();

    const historyPage = await browser.newPage();
    await installUiMock(historyPage);
    await historyPage.goto(base);
    await historyPage.locator(".bottom-settings").click();
    await expect(historyPage).toHaveURL(`${base}/settings`);
    for (const value of ["first-cycle", "second-cycle"]) {
      await historyPage.getByLabel("API-ключ Gemini", { exact: true }).fill(value);
      await historyPage.getByLabel("API-ключ Gemini", { exact: true }).fill("");
      await expect.poll(() => historyPage.evaluate(() => history.state?.chronicleDirtyGuard)).toBeUndefined();
    }
    await historyPage.evaluate(() => history.back());
    await expect(historyPage).toHaveURL(`${base}/`);
    await historyPage.locator(".bottom-settings").click();
    await expect(historyPage).toHaveURL(`${base}/settings`);
    await historyPage.getByLabel("API-ключ Gemini", { exact: true }).fill("unsaved-back-key");
    await historyPage.evaluate(() => history.back());
    await expect(historyPage.getByText("Есть несохранённые изменения", { exact: true })).toBeVisible();
    await historyPage.getByRole("button", { name: "Продолжить редактирование" }).click();
    await expect(historyPage.getByLabel("API-ключ Gemini", { exact: true })).toHaveValue("unsaved-back-key");
    await historyPage.evaluate(() => history.back());
    await historyPage.getByRole("button", { name: "Отбросить и вернуться" }).click();
    await expect(historyPage).toHaveURL(`${base}/`);
    await historyPage.close();
    const pendingPage = await browser.newPage();
    await installUiMock(pendingPage);
    await pendingPage.addInitScript(() => {
      const original = Element.prototype.scrollIntoView;
      Object.assign(window, { hiddenScrolls: 0 });
      Element.prototype.scrollIntoView = function (...args) { if (document.querySelector('[role="dialog"]')) (window as unknown as { hiddenScrolls: number }).hiddenScrolls++; return original.apply(this, args); };
    });
    let finishTurn!: () => void;
    let completed = false;
    let accepted = false;
    const afterTurn = { ...mockSnapshot, session: { ...mockSnapshot.session, turnCount: 4 }, turns: [...mockSnapshot.turns, { ...mockSnapshot.turns[2], id: "completed-under-settings", turnNumber: 4, content: "Ход завершился под настройками." }] };
    await pendingPage.route(`**/api/sessions/${mockSessionId}?*`, route => route.fulfill({ json: completed ? afterTurn : mockSnapshot }));
    await pendingPage.route("**/requests/*", route => route.fulfill({ json: { status: "running", stage: "generation", result: null } }));
    await pendingPage.route("**/act", async route => {
      accepted = true;
      await new Promise<void>(resolve => { finishTurn = resolve; });
      completed = true;
      await route.fulfill({ json: { ok: true, turnNumber: 4, needsCompaction: false } });
    });
    await pendingPage.goto(`${base}/play/${mockSessionId}`);
    await pendingPage.locator("#action-input").fill("Продолжить путь");
    await pendingPage.locator("#action-input").press("Control+Enter");
    await expect.poll(() => accepted).toBe(true);
    await pendingPage.locator(".bottom-settings").click();
    const pendingSettings = pendingPage.getByRole("dialog", { name: "Настройки пространства" });
    await expect(pendingSettings).toBeVisible();
    finishTurn();
    await expect(pendingPage.getByText("Ход завершился под настройками.", { exact: true })).toBeAttached();
    assert.equal(await pendingPage.evaluate(() => (window as unknown as { hiddenScrolls: number }).hiddenScrolls), 0);
    await pendingSettings.getByRole("button", { name: "Вернуться в игру" }).click();
    await expect(pendingPage.getByText("Ход завершился под настройками.", { exact: true })).toBeVisible();
    await pendingPage.close();
    // Inspect actual transport routing, including an old persisted custom request.
    for (const scenario of [
      { text: "  Выйти на Пепельный тракт  ", custom: false, method: "form" },
      { text: "Выйти на пепельный тракт", custom: true, method: "keyboard" },
      { text: "Выйти на Пепельный тракт", custom: false, method: "button" },
      { text: "Выйти на Пепельный тракт", custom: true, method: "retry" },
    ]) {
      const testPage = await browser.newPage();
      await installUiMock(testPage);
      let payload: Record<string, unknown> | undefined;
      await testPage.route("**/act", async route => {
        payload = route.request().postDataJSON();
        await route.fulfill({ status: 502, json: { code: "AI_FAILED", message: "Mock provider failure" } });
      });
      await testPage.route("**/requests/*", route => route.fulfill({ status: 404, json: { code: "NOT_FOUND" } }));
      if (scenario.method === "retry") await testPage.addInitScript(({ sessionId, text }) => {
        sessionStorage.setItem(`chronicle:pending:${sessionId}`, JSON.stringify({ id: "old-client-request", sessionId, action: text, custom: true, expectedTurn: 3 }));
      }, { sessionId: mockSessionId, text: scenario.text });
      await testPage.goto(`${base}/play/${mockSessionId}`);
      await expect(testPage.locator("#action-input")).toBeVisible();
      if (scenario.method === "button") await testPage.getByRole("button", { name: /Выйти на Пепельный тракт/ }).click();
      else {
        await testPage.locator("#action-input").fill(scenario.text);
        await testPage.locator("#action-input").press("Control+Enter");
      }
      await expect.poll(() => payload).toBeTruthy();
      assert.equal(payload!.custom, scenario.custom);
      assert.equal(payload!.action, scenario.text.trim());
      if (scenario.method === "retry") assert.equal(payload!.requestId, "old-client-request");
      await testPage.close();
    }
    if (errors.length) throw new Error(errors.join("\n"));
    console.log("PASS: action kind, sidebar, reading, settings overlay and dirty guard (mock API)");
  } finally { await browser.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
