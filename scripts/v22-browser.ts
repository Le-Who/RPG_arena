import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import type { Session, Snapshot } from "../src/lib/ui-data";
const base = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const owned: string[] = [];
async function run() {
  await mkdir("artifacts", { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  try {
    const config = await (await fetch(base + "/api/settings")).json();
    expect(config.keysCount + config.envKeysCount).toBe(0);
    const { session } = await (await fetch(base + "/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "preset", scenarioId: "echo-station", characterIndex: 0 }) })).json() as { session: Session };
    owned.push(session.id);
    await page.goto(`${base}/play/${session.id}`, { waitUntil: "networkidle" });
    await expect(page.locator(".play-banner h1")).toHaveText("Станция «Эхо»");
    await page.getByRole("button", { name: "Развилки истории", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Развилки истории" })).toBeVisible();
    await page.getByRole("textbox", { name: "Как назовём этот момент?" }).fill("Перед первым решением");
    await page.getByRole("button", { name: "Сохранить точку", exact: true }).click();
    await expect(page.locator(".checkpoint-point")).toHaveCount(1);
    await expect(page.locator(".point-heading")).toContainText("Ход 1");
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: "artifacts/v22-checkpoints-desktop.png" });
    await page.getByRole("button", { name: "Закрыть", exact: true }).click();
    // The server commits, but this response never reaches the browser. The stored request must recover.
    let committed!: () => void, deliver!: () => void;
    const saved = new Promise<void>((resolve) => { committed = resolve; });
    const release = new Promise<void>((resolve) => { deliver = resolve; });
    let submissions = 0;
    page.on("request", (req) => { if (req.method() === "POST" && req.url().endsWith(`/api/sessions/${session.id}/act`)) submissions++; });
    await page.route(`**/api/sessions/${session.id}/act`, async (route) => {
      const result = await route.fetch(); expect(result.status()).toBe(200); committed();
      await release; await route.abort("failed").catch(() => {});
    });
    await page.locator(".action-choices>button").first().click();
    await saved;
    const pending = await page.evaluate((id) => sessionStorage.getItem(`chronicle:pending:${id}`), session.id);
    expect(pending).not.toBeNull();
    const stored = JSON.parse(pending!); expect(stored.expectedTurn).toBe(1); expect(stored.id).toBeTruthy();
    await page.reload({ waitUntil: "domcontentloaded" }); deliver(); await page.unroute(`**/api/sessions/${session.id}/act`);
    await expect(page.locator("#turn-2")).toBeVisible({ timeout: 15000 });
    await expect.poll(() => page.evaluate((id) => sessionStorage.getItem(`chronicle:pending:${id}`), session.id)).toBeNull();
    expect(submissions).toBe(1);
    const recovered = await (await fetch(`${base}/api/sessions/${session.id}`)).json() as Snapshot;
    expect(recovered.session.turnCount).toBe(2); expect(recovered.turns.filter((turn) => turn.role === "player")).toHaveLength(1);
    console.log("PASS: browser keeps requestId before sending and recovers a committed turn after lost response/reload without resubmitting");

    await page.getByRole("button", { name: "Развилки истории", exact: true }).click();
    await page.getByRole("button", { name: "Другой путь", exact: true }).click();
    await page.getByRole("textbox", { name: "Название новой истории" }).fill("Эхо — мирный путь");
    const forkResponse = page.waitForResponse((response) => response.url().endsWith("/fork") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Создать независимую ветку", exact: false }).click();
    const forked = await (await forkResponse).json() as { session: Session };
    expect(forked.session?.id).toBeTruthy();
    const branchId = forked.session.id; owned.push(branchId);
    // SPA route readiness is defined by URL + rendered story, not an old document's load event.
    await expect(page).toHaveURL(`${base}/play/${branchId}`, { timeout: 15000 });
    await expect(page.locator(".branch-origin-banner")).toContainText("Перед первым решением");
    await expect(page.locator(".play-banner h1")).toHaveText("Эхо — мирный путь");
    await expect(page.locator("#turn-2")).toHaveCount(0);
    await page.getByRole("textbox", { name: "Ваше действие" }).fill("Ответить на сигнал и представиться");
    await page.getByRole("button", { name: "Сделать ход", exact: true }).click();
    await expect(page.locator("#turn-2")).toBeVisible({ timeout: 15000 });
    const source = await (await fetch(`${base}/api/sessions/${session.id}`)).json() as Snapshot;
    expect(source.session.turnCount).toBe(2); expect(source.turns.some((turn) => turn.content === "Ответить на сигнал и представиться")).toBe(false);
    await page.screenshot({ path: "artifacts/v22-branch-play.png", fullPage: true });
    await page.getByRole("link", { name: "Исходная история", exact: false }).click();
    await page.getByRole("button", { name: "Развилки истории", exact: true }).click();
    await expect(page.locator(".point-branches")).toContainText("Эхо — мирный путь");
    await page.getByRole("button", { name: "Удалить точку Перед первым решением" }).click();
    await page.locator(".point-delete-confirm").getByRole("button", { name: "Удалить", exact: true }).click();
    await expect(page.locator(".checkpoint-point")).toHaveCount(0);
    expect((await fetch(`${base}/api/sessions/${branchId}`)).status).toBe(200);
    await page.keyboard.press("Escape");
    console.log("PASS: checkpoint creation, immutable fork, original remains unchanged, lineage links and confirmed checkpoint deletion preserve the branch");

    await page.getByRole("link", { name: "Пульс движка", exact: true }).click();
    await expect(page.locator(".system-health-strip")).toContainText("PostgreSQL отвечает");
    await expect(page.getByRole("button", { name: "Обработать очередь", exact: true })).toBeDisabled();
    await expect(page.locator(".worker-card")).toContainText("Не запущен");
    await page.screenshot({ path: "artifacts/v22-system-desktop.png", fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/play/${branchId}`, { waitUntil: "networkidle" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.getByRole("button", { name: "Развилки истории", exact: true }).click();
    await page.getByRole("textbox", { name: "Как назовём этот момент?" }).fill("Мобильная точка");
    await page.getByRole("button", { name: "Сохранить точку", exact: true }).click(); await expect(page.locator(".checkpoint-point")).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: "artifacts/v22-checkpoints-mobile.png" });
    await page.keyboard.press("Escape");
    await page.goto(`${base}/system`, { waitUntil: "networkidle" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: "artifacts/v22-system-mobile.png", fullPage: true });
    expect(errors).toEqual([]);
    console.log("PASS: real system diagnostics, disabled AI actions without keys, desktop/mobile branches and system page without overflow or page errors");
  } finally {
    for (const id of owned.reverse()) await fetch(`${base}/api/sessions/${id}`, { method: "DELETE" });
    await browser.close();
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
