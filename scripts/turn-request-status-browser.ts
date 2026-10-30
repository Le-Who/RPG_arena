/** Real turn hook with synthetic transport; no campaign database or provider calls. */
import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { launchFixtureBrowser } from "./lib/launch-fixture-browser";
import type { TurnResponse } from "../src/lib/turn-contract";

const sessionId = "75000000-0000-4000-8000-000000000001";
const itemId = "75000000-0000-4000-8000-000000000003";
const pending = { sessionId, id: "saved-request", action: "Осмотреть «Ключ»", custom: true, expectedTurn: 1, itemIds: [itemId] };

async function main() {
  const output = resolve("output/playwright/turn-request-status");
  await mkdir(output, { recursive: true });
  const bundle = await build({ stdin: { contents: `
    import React from "react";import {createRoot} from "react-dom/client";
    import {useTurnRequest} from "./src/components/use-turn-request";
    function Fixture(){const turn=useTurnRequest(${JSON.stringify(sessionId)},async()=>{window.committed=true});
      return <><button disabled={!turn.recoveryReady||turn.busy} onClick={()=>void turn.send("Осмотреть «Ключ»",true,1,[${JSON.stringify(itemId)}])}>Отправить</button>
      <button disabled={!turn.pending||turn.busy} onClick={()=>void turn.retry()}>Повторить</button>
      <output aria-label="Ошибка">{turn.error}</output><output aria-label="Ожидание">{String(turn.busy)}</output>
      <output aria-label="Сохранённый запрос">{turn.pending?.id||""}</output><output aria-label="Этап">{turn.stage}</output></>}
    createRoot(document.getElementById("root")).render(<React.StrictMode><Fixture/></React.StrictMode>);
  `, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"development"' } });
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : "text/html; charset=utf-8");
    res.end(req.url === "/fixture.js" ? bundle.outputFiles[0].text : '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><main id="root"></main><script src="/fixture.js"></script></body></html>');
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const browser = await launchFixtureBrowser(server, () => chromium.launch());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const reports: unknown[] = [];
  try {
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(p => sessionStorage.setItem(`chronicle:pending:${p.sessionId}`, JSON.stringify(p)), pending);
      await page.route("**/requests/*", route => route.fulfill({ json: { requestId: route.request().url().split("/").at(-1), status: "not_accepted" } }));
      await page.goto(base);
      await expect(page.getByLabel("Ошибка")).toContainText("Сервер ещё не принял это действие");
      await expect(page.getByRole("button", { name: "Повторить", exact: true })).toBeEnabled();
      await expect(page.getByLabel("Сохранённый запрос")).toHaveText("saved-request");

      const failure = "ИИ-мастер сейчас недоступен. Ход не записан — повторите через минуту.";
      let release!: () => void;
      const gate = new Promise<void>(done => { release = done; });
      let submitted: Record<string, unknown> | undefined;
      await page.route("**/act", async route => {
        submitted = route.request().postDataJSON();
        await gate;
        await route.fulfill({ contentType: "application/x-ndjson", body: `${JSON.stringify({ type: "error", error: { ok: false, code: "AI_FAILED", message: failure } })}\n` });
      });
      await page.getByRole("button", { name: "Повторить", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => submitted).toEqual({ action: pending.action, custom: true, expectedTurn: 1, requestId: "saved-request", itemIds: [itemId] });
      await expect(page.getByLabel("Ошибка")).toBeEmpty();
      await expect(page.getByLabel("Ожидание")).toHaveText("true");
      release();
      await expect(page.getByLabel("Ошибка")).toHaveText(failure);
      // A later absent-row poll must not overwrite the actual POST failure.
      const nextPoll = page.waitForResponse(response => response.url().includes("/requests/"));
      await nextPoll;
      await expect(page.getByLabel("Ошибка")).toHaveText(failure);
      await expect(page.getByLabel("Сохранённый запрос")).toHaveText("saved-request");
      await page.screenshot({ path: `${output}/${viewport.width}-failure.png` });

      for (const [status, message] of [[404, "Кампания не найдена."], [401, "Профиль изменился. Обновите страницу."]] as const) {
        await page.route("**/requests/*", route => route.fulfill({ status, json: { code: status === 404 ? "NOT_FOUND" : "IDENTITY_CHANGED", message } }));
        await page.reload();
        await expect(page.getByLabel("Ошибка")).toHaveText(message);
        await expect(page.getByLabel("Ожидание")).toHaveText("false");
      }
      expect(errors).toEqual([]);
      reports.push({ viewport, missingRequestRecoverable: true, retryIdentityAndItemRetained: true, postErrorPreserved: true, actualAccessErrorsPreserved: true, errors });
      await page.close();

      const recoveryPage = await browser.newPage({ viewport });
      const recoveryErrors: string[] = [];
      recoveryPage.on("pageerror", error => recoveryErrors.push(error.message));
      let interruptedId = "", completed = false;
      const committed = (): TurnResponse => ({ ok: true, requestId: interruptedId, turnNumber: 2, playerAction: pending.action,
        narration: "Вы рассматриваете ключ.", choices: [], dice: null, outcome: "success", modelUsed: "fixture", taskType: "resolution",
        applied: { hp: 0, xp: 0, gold: 0, danger: 0, levelUp: false, dead: false, location: null, quests: [], npcs: [], inventory: [], sceneObjects: [], conditions: { added: [], removed: [] }, rejected: [] },
        needsCompaction: false, dead: false, retrieved: [], skippedModels: [], warnings: [] });
      await recoveryPage.route("**/act", route => {
        interruptedId = route.request().postDataJSON().requestId;
        return route.fulfill({ contentType: "application/x-ndjson", body: `${JSON.stringify({ type: "stage", stage: "context" })}\n` });
      });
      await recoveryPage.route("**/requests/*", route => route.fulfill({ json: completed
        ? { requestId: interruptedId, status: "completed", stage: "completed", baseTurn: 1, retryAfter: 0, error: null, result: committed() }
        : { requestId: interruptedId, status: "not_accepted" } }));
      await recoveryPage.goto(base);
      await recoveryPage.getByRole("button", { name: "Отправить", exact: true }).click();
      await expect(recoveryPage.getByLabel("Ошибка")).toContainText("STREAM_INTERRUPTED");
      completed = true;
      await expect.poll(() => recoveryPage.evaluate(() => (window as unknown as { committed: boolean }).committed)).toBe(true);
      await expect(recoveryPage.getByLabel("Сохранённый запрос")).toBeEmpty();
      await expect(recoveryPage.getByLabel("Ошибка")).toBeEmpty();
      expect(await recoveryPage.evaluate(id => sessionStorage.getItem(`chronicle:pending:${id}`), sessionId)).toBeNull();
      expect(recoveryErrors).toEqual([]);
      reports.push({ viewport, interruptedStreamRecoveredByPoll: true, errors: recoveryErrors });
      await recoveryPage.close();
    }
    await writeFile(`${output}/report.json`, JSON.stringify(reports, null, 2));
    console.log(JSON.stringify(reports));
  } finally { await browser.close(); await new Promise<void>(done => server.close(() => done())); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
