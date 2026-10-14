/** Isolated browser checks: local production app, synthetic API data, no provider calls. */
import { chromium, expect } from "@playwright/test";
import { installUiMock, mockSessionId, mockSnapshot } from "./ui-mock";
import { mkdir } from "node:fs/promises";

async function main() {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    await installUiMock(page);
    let unavailable = true;
    await page.route(`**/api/sessions/${mockSessionId}`, route => route.fulfill({ json: { ...mockSnapshot,
      turns: mockSnapshot.turns.map(turn => turn.role === "narrator" && turn.turnNumber === 3 ? { ...turn, modelUsed: "fixture-model", contextMeta: {
        narrativeVerification: { checks: [{ status: unavailable ? "unavailable" : "verified" }] },
      } } : turn),
    } }));
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const base = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3027";
    await page.goto(`${base}/play/${mockSessionId}`);
    const note = page.getByText("Без проверки Jev", { exact: true });
    await expect(note).toHaveCount(1);
    await note.scrollIntoViewIfNeeded();
    await expect(note).toBeVisible();
    await expect(note).not.toHaveAttribute("role", "alert");
    await expect(page.locator("#action-input")).toBeEnabled();
    await page.locator("#action-input").fill("Продолжить разговор");
    await expect(page.locator("#action-input")).toHaveValue("Продолжить разговор");
    await mkdir("output/playwright/security-indicator", { recursive: true });
    await note.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "output/playwright/security-indicator/desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await note.scrollIntoViewIfNeeded();
    await expect(note).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: "output/playwright/security-indicator/mobile.png" });
    await page.reload();
    await expect(note).toHaveCount(1);
    unavailable = false;
    await page.reload();
    await expect(note).toHaveCount(0);
    expect(errors).toEqual([]);
    console.log("PASS: unavailable marker, enabled composer, desktop/mobile, reload, recovery; no browser errors.");
  } finally { await browser.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
