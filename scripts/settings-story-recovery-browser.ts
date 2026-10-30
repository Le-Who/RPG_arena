/** Synthetic APIs on a disposable loopback server. No provider/real DB calls. */
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { installUiMock, mockSession, settings } from "./ui-mock";
import type { Settings } from "../src/lib/ui-data";

async function main() {
  const base = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3043";
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname)) throw new Error("Loopback only");
  const output = "output/playwright/settings-story-recovery";
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error" && /same key|unique.*key/i.test(message.text())) errors.push(message.text()); });
      let current: Settings = { ...settings, keysCount: 1, keysMasked: ["synt••••old"], useLiveAI: true, canUseLive: true, textProvider: "gemini", textModel: "" };
      let owner = mockSession.ownerId, autofills = 0;
      let canonicalGate: Promise<void> | null = null, enteredCanonical = false;
      const ready = () => { current = { ...current, canUseLive: current.useLiveAI && current.keysCount > 0 }; };
      await installUiMock(page, { initialSettings: current });
      await page.route("**/api/bootstrap", route => route.fulfill({ json: { ok: true,
        identity: { kind: "guest", profileId: owner, guestProfileId: owner, account: null, isAdmin: false, capabilities: { administration: false }, pendingGuestCampaigns: 0, passwordRecoveryAvailable: false },
        sessions: owner === mockSession.ownerId ? [mockSession] : [], settings: current, workspace: { id: owner, displayName: "Искатель историй", favorites: [], reading: { textScale: "normal", measure: "normal", theme: "midnight", motion: "reduced" } },
      } }));
      await page.route("**/api/settings", async route => {
        if (route.request().method() === "POST") {
          const body = route.request().postDataJSON();
          if (body.removeIndex) { expect(body.removeIndex).toEqual([0]); current = { ...current, keysCount: 0, keysMasked: [] }; }
          else { expect(body.keysText).toBeUndefined(); current = { ...current, ...body }; }
          ready();
        }
        if (route.request().method() === "GET" && canonicalGate) { enteredCanonical = true; await canonicalGate; }
        await route.fulfill({ json: current });
      });
      await page.route("**/api/settings/provider-connections", async route => {
        if (route.request().method() === "POST") {
          expect(route.request().postDataJSON()).toEqual({ provider: "gemini", apiKey: "synthetic-new-key" });
          current = { ...current, keysCount: 1, keysMasked: ["synt••••new"] }; ready();
        }
        await route.fulfill({ json: { geminiConfigured: current.keysCount > 0, openrouterConfigured: false, pollinationsConfigured: false } });
      });
      await page.route("**/api/settings/text-provider", async route => {
        if (route.request().method() === "POST") {
          const body = route.request().postDataJSON();
          expect(body.provider).toBe("gemini"); current = { ...current, useLiveAI: body.useLiveAI }; ready();
        }
        await route.fulfill({ json: { provider: "gemini", model: "", useLiveAI: current.useLiveAI, openrouterConfigured: false, pollinationsConfigured: false } });
      });
      await page.route("**/api/story-drafts/autofill", async route => {
        if (!current.canUseLive) return route.fulfill({ status: 409, json: { code: "AI_REQUIRED", message: "Подключите и включите рассказчика." } });
        const draft = route.request().postDataJSON().draft;
        expect(draft.title).toBe("Мой несохранённый мир");
        expect(draft.pitch).toBe("Я хочу историю о жизни в небольшом городе.");
        autofills++;
        await route.fulfill({ json: { patch: { era: "Наши дни", name: "Мира" }, modelUsed: current.narrationModel } });
      });
      await page.goto(`${base}/campaigns`);
      const open = async () => {
        await page.getByRole("button", { name: "Новая кампания", exact: true }).click();
        await page.getByRole("button", { name: "Своя история", exact: true }).click();
      };
      await open();
      await page.locator('input[name="title"]').fill("Мой несохранённый мир");
      await page.locator('textarea[name="pitch"]').fill("Я хочу историю о жизни в небольшом городе.");
      await page.keyboard.press("Escape");
      await open();
      await expect(page.locator('input[name="title"]')).toHaveValue("Мой несохранённый мир");
      await expect(page.locator('textarea[name="pitch"]')).toHaveValue("Я хочу историю о жизни в небольшом городе.");
      await page.getByRole("button", { name: "Далее: герой и правила" }).click();
      await page.locator('input[name="name"]').fill("Мира");
      await page.locator('select[name="storyKind"]').selectOption("scene");
      await page.getByRole("button", { name: /Лёгкие правила/ }).click();
      await page.keyboard.press("Escape");
      await context.clearCookies(); await page.reload();
      await open();
      await expect(page.locator('input[name="name"]')).toHaveValue("Мира");
      await expect(page.locator('select[name="storyKind"]')).toHaveValue("scene");
      await page.getByRole("button", { name: "Назад к миру", exact: true }).click();
      await page.keyboard.press("Escape");
      // Standalone settings: one Gemini key field, immediately visible narrator/model.
      await context.clearCookies(); await page.goto(`${base}/settings`);
      await expect(page.getByLabel("Провайдер рассказчика", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Модель Gemini для повествования", { exact: true })).toBeVisible();
      await expect(page.getByLabel("API-ключ Gemini", { exact: true })).toHaveCount(1);
      await expect(page.getByText("Прямой Gemini", { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Изменить Gemini", exact: true }).click();
      await page.getByRole("button", { name: "Удалить ключ 1", exact: true }).click();
      await expect(page.locator(".connection-status")).toHaveText("Базовый режим");
      await expect(page.getByRole("switch", { name: "Живой рассказчик", exact: true })).toBeChecked();
      await page.getByLabel("API-ключ Gemini", { exact: true }).fill("synthetic-new-key");
      await page.getByRole("button", { name: "Сохранить подключения", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(page.locator(".connection-status")).toHaveText("Рассказчик подключён");
      await expect(page.getByLabel("API-ключ Gemini", { exact: true })).toHaveValue("");
      // Same save must persist pending keys before narrator preferences.
      await page.getByRole("switch", { name: "Живой рассказчик", exact: true }).click();
      await page.getByRole("button", { name: "Сохранить рассказчика", exact: true }).click();
      await expect(page.locator(".connection-status")).toHaveText("Базовый режим");
      await page.getByLabel("API-ключ Gemini", { exact: true }).fill("synthetic-new-key");
      await page.getByRole("combobox", { name: "Сохранить ключ Gemini", exact: true }).selectOption("replace");
      await page.getByRole("switch", { name: "Живой рассказчик", exact: true }).click();
      await page.getByLabel("Модель Gemini для повествования", { exact: true }).selectOption("gemini-3.8-flash");
      await page.getByRole("button", { name: "Сохранить рассказчика", exact: true }).click();
      await expect(page.getByLabel("API-ключ Gemini", { exact: true })).toHaveValue("");
      await expect(page.locator(".connection-status")).toHaveText("Рассказчик подключён");
      await page.locator("#text-provider").scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${output}/${width}-settings.png`, fullPage: true });
      await page.locator("#text-provider").screenshot({ path: `${output}/${width}-narrator.png` });
      await page.locator("#service-connections").screenshot({ path: `${output}/${width}-connections.png` });
      await context.clearCookies(); await page.goto(`${base}/campaigns`);
      await open();
      await page.getByRole("button", { name: "Заполнить пустые поля", exact: true }).click();
      await expect(page.locator('input[name="era"]')).toHaveValue("Наши дни");
      expect(autofills).toBe(1);
      await expect(page.locator('input[name="title"]')).toHaveValue("Мой несохранённый мир");
      await page.screenshot({ path: `${output}/${width}-restored.png` });
      // Slow canonical refresh: returning to the draft must wait for the new live state.
      current = { ...current, useLiveAI: false, canUseLive: false };
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(page.locator(".connection-status")).toHaveText("Базовый режим");
      await page.getByRole("button", { name: "Заполнить пустые поля", exact: true }).click();
      const overlay = page.getByRole("dialog", { name: "Настройки пространства", exact: true });
      await expect(overlay).toBeVisible();
      await overlay.getByRole("button", { name: "Изменить Gemini", exact: true }).click();
      await overlay.getByLabel("API-ключ Gemini", { exact: true }).fill("synthetic-new-key");
      await overlay.getByRole("combobox", { name: "Сохранить ключ Gemini", exact: true }).selectOption("replace");
      await overlay.getByRole("switch", { name: "Живой рассказчик", exact: true }).click();
      let release!: () => void;
      canonicalGate = new Promise<void>(resolve => { release = resolve; });
      await overlay.getByRole("button", { name: "Сохранить рассказчика", exact: true }).click();
      await expect.poll(() => enteredCanonical).toBe(true);
      await overlay.getByRole("button", { name: "Вернуться к истории", exact: true }).last().click();
      await expect(overlay).toBeVisible();
      await page.keyboard.press("Escape"); await expect(overlay).toBeVisible();
      canonicalGate = null; release();
      await expect(overlay.getByText("Готов к генерации", { exact: true })).toBeVisible();
      await expect(overlay.getByRole("button", { name: "Сохранить настройки", exact: true })).toBeEnabled();
      await overlay.getByRole("button", { name: "Вернуться к истории", exact: true }).last().click();
      await expect(overlay).toHaveCount(0);
      await page.getByRole("button", { name: "Заполнить пустые поля", exact: true }).click();
      await expect.poll(() => autofills).toBe(2);
      // A changed identity closes the form and clears both local draft slots.
      owner = "guest:another-profile";
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(page.getByRole("dialog", { name: "Новая история", exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("chronicle:creator-draft:")))).toEqual([]);
      expect(errors).toEqual([]);
      await context.close();
      console.log(`PASS ${width}px: draft close/reload, choices, key removal/replacement, narrator save, model, autofill, identity, keyboard`);
    }
  } finally { await browser.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
