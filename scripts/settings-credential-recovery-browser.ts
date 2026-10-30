/** Isolated UI regression with synthetic API responses; never calls providers or a real DB. */
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { installUiMock, mockSession, settings } from "./ui-mock";
import type { Settings } from "../src/lib/ui-data";

async function main() {
  const base = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3043";
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname)) throw new Error("Use a disposable loopback server.");
  const output = "output/playwright/settings-credential-recovery";
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  try {
    for (const [name, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]] as const) {
      const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      let repaired = false, signedIn = false, narrativeRepaired = false;
      const initialSettings: Settings = { ...settings, keysMasked: ["••••"], keysCount: 1, useLiveAI: true, canUseLive: false, credentialIssues: ["gemini"] };
      await installUiMock(page, { initialSettings });
      await page.route(url => url.searchParams.has("_rsc"), route => route.abort());
      const canonical = () => repaired ? { ...initialSettings, credentialIssues: undefined, keysMasked: ["synt••••mini"], canUseLive: true } : initialSettings;
      const identity = () => ({ kind: signedIn ? "account" : "guest", profileId: mockSession.ownerId,
        account: signedIn ? { id: "00000000-0000-4000-8000-000000000088", login: "returning-user", profileId: mockSession.ownerId } : null,
        guestProfileId: mockSession.ownerId, isAdmin: false, capabilities: { administration: false }, pendingGuestCampaigns: 0, passwordRecoveryAvailable: false });
      await page.route("**/api/bootstrap", route => route.fulfill({ json: { ok: true, identity: identity(), sessions: [mockSession], settings: canonical(),
        workspace: { id: mockSession.ownerId, displayName: "Искатель историй", favorites: [], reading: { textScale: "normal", measure: "normal", theme: "midnight", motion: "reduced" } } } }));
      await page.route("**/api/settings", route => route.fulfill({ json: canonical() }));
      await page.route("**/api/settings/provider-connections", async route => {
        if (route.request().method() === "POST") {
          expect(route.request().postDataJSON()).toEqual({ provider: "gemini", apiKey: "synthetic-replacement-gemini" });
          repaired = true;
        }
        await route.fulfill({ json: { geminiConfigured: true, openrouterConfigured: false, pollinationsConfigured: false,
          ...(repaired ? {} : { credentialIssues: ["gemini"] }) } });
      });
      await page.route("**/api/auth/login", async route => {
        expect(route.request().postDataJSON()).toEqual({ login: "returning-user", password: "synthetic-password" });
        signedIn = true;
        await route.fulfill({ json: { ok: true, identity: identity() } });
      });
      await page.route("**/api/settings/narrative", async route => {
        if (route.request().method() === "POST") {
          expect(route.request().postDataJSON()).toEqual({ provider: "openrouter", enabled: true, key: "synthetic-new-verification-key" });
          narrativeRepaired = true;
        }
        await route.fulfill({ json: { enabled: true, active: narrativeRepaired, provider: "openrouter", configured: true,
          maskedKey: narrativeRepaired ? "••••-key" : "••••", model: "typesafe/jev-1.13", credentialSource: "personal", administratorAvailable: false,
          ...(narrativeRepaired ? {} : { credentialIssue: true }) } });
      });
      await page.goto(`${base}/campaigns`);
      await expect(page.getByRole("link", { name: /Пепельная корона/ }).first()).toBeVisible();
      // Page requests bypass DB resolution; the intercepted API owns the synthetic identity.
      await context.clearCookies();
      await page.goto(`${base}/settings`);
      await expect(page.getByRole("button", { name: "Создать аккаунт", exact: true })).toBeVisible();
      const replace = page.getByRole("button", { name: "Заменить ключ Gemini", exact: true });
      await expect(replace).toBeVisible();
      await expect(page.getByText("Нужно сохранить ключ заново", { exact: true })).toBeVisible();
      await replace.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: `${output}/${name}-needs-replacement.png` });
      await page.getByRole("button", { name: "Уже есть аккаунт", exact: true }).click();
      await page.getByRole("textbox", { name: "Логин", exact: true }).fill("returning-user");
      await page.getByLabel("Пароль", { exact: true }).fill("synthetic-password");
      await page.getByRole("button", { name: "Войти", exact: true }).click();
      await expect(page.getByRole("button", { name: "Выйти", exact: true })).toBeVisible();
      await replace.focus();
      await page.keyboard.press("Enter");
      const keyInput = page.locator("#service-connections").getByLabel("API-ключ Gemini", { exact: true });
      await keyInput.fill("synthetic-replacement-gemini");
      const save = page.getByRole("button", { name: "Сохранить подключения", exact: true });
      await save.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByText("Подключения сохранены.", { exact: true })).toBeVisible();
      await expect(page.getByText("Нужно сохранить ключ заново", { exact: true })).toHaveCount(0);
      await expect(keyInput).toHaveValue("");
      await expect(page.locator(".connection-status")).toHaveText("Рассказчик подключён");
      await page.locator("#service-connections").scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: `${output}/${name}-recovered.png` });
      await page.getByText("Дополнительные настройки ИИ", { exact: true }).click();
      await page.getByText("Дополнительная проверка повествования", { exact: true }).click();
      const verificationWarning = page.getByText(/Сохранённый ключ проверки устарел или недоступен/);
      await expect(verificationWarning).toBeVisible();
      const verificationInput = page.getByLabel("Отдельный API-ключ OpenRouter", { exact: true });
      await verificationInput.fill("synthetic-new-verification-key");
      await page.getByRole("button", { name: "Сохранить проверку", exact: true }).click();
      await expect(page.getByText("Настройки проверки сохранены.", { exact: true })).toBeVisible();
      await expect(verificationWarning).toHaveCount(0);
      await expect(verificationInput).toHaveValue("");
      expect(repaired && signedIn && narrativeRepaired).toBe(true);
      expect(errors).toEqual([]);
      await context.close();
    }
    console.log("PASS: campaigns, registration/login controls, keyboard key replacement, live readiness, narrative-key recovery, desktop/mobile; no browser errors.");
  } finally { await browser.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
