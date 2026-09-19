import { chromium, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { installUiMock, mockSessionId } from "./ui-mock";
const base = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const mock = process.env.UI_AUDIT_MOCK === "1";
const output = "output/playwright";

async function setTheme(page: Page, theme: string, text = "normal") {
  await page.evaluate(([t, x]) => { document.documentElement.setAttribute("data-theme", t); document.documentElement.setAttribute("data-text", x); }, [theme, text]);
  await page.waitForTimeout(250);
}

async function main() {
  await mkdir(output, { recursive: true });
  const sid = mock ? mockSessionId : (await (await fetch(base + "/api/sessions")).json()).sessions[0].id;
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1020 }, deviceScaleFactor: 2 });
  if (mock) await installUiMock(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });

  // World map lives in the world tab
  await page.goto(`${base}/play/${sid}`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("tab", { name: "Мир", exact: true }).click();
  await page.waitForTimeout(500);
  const hasMap = await page.locator(".gx-map-svg").count();
  const nodes = await page.locator(".gx-map-pin").count();
  const travel = await page.locator("button.gx-map-pin:not(.is-current)").count();
  console.log(`world map: svg=${hasMap} nodes=${nodes} travelButtons=${travel}`);
  await page.screenshot({ path: `${output}/v25-map.png`, clip: { x: 1010, y: 0, width: 420, height: 1020 } });

  // Expanded map remains keyboard-operable.
  await page.getByRole("button", { name: "Открыть карту крупно" }).click();
  await expect(page.getByRole("dialog", { name: "Карта мира" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Карта мира" })).toHaveCount(0);
  console.log("map dialog keyboard: Escape closes");

  // Keyboard: roving tabindex moves between panels
  await page.getByRole("tab", { name: "Мир", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(200);
  const afterArrow = await page.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim());
  await page.keyboard.press("Home");
  await page.waitForTimeout(200);
  const afterHome = await page.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim());
  console.log(`tablist keyboard: ArrowRight→"${afterArrow}" Home→"${afterHome}"`);

  // Travel button prefills the composer
  await page.getByRole("tab", { name: "Мир", exact: true }).click();
  await page.waitForTimeout(250);
  if (travel > 0) {
    await page.locator("button.gx-map-pin:not(.is-current)").first().click();
    await page.waitForTimeout(250);
    const value = await page.locator("#action-input").inputValue();
    console.log(`travel prefill: "${value.slice(0, 48)}"`);
  }

  // Themes
  for (const theme of ["midnight", "sepia", "contrast"]) {
    await setTheme(page, theme);
    await page.screenshot({ path: `${output}/v25-theme-${theme}.png`, clip: { x: 0, y: 0, width: 1000, height: 780 } });
  }
  await setTheme(page, "midnight", "large");
  await page.screenshot({ path: `${output}/v25-text-large.png`, clip: { x: 0, y: 0, width: 1000, height: 780 } });
  await setTheme(page, "midnight", "normal");

  // Settings reading card
  await page.goto(`${base}/settings`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.locator("#reading").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${output}/v25-reading-settings.png` });

  await browser.close();
  console.log("pageErrors:", errors.length ? errors : 0);
  if (hasMap !== 1 || nodes < 2 || travel < 1 || afterArrow !== "Память" || afterHome !== "Герой" || errors.length) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exit(1); });
