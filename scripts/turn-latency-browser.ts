import { chromium, expect, type Page } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { installUiMock, mockSessionId, mockSnapshot } from "./ui-mock";

const base = process.env.SMOKE_BASE_URL ?? "http://localhost:3010";
const itemId = mockSnapshot.inventory[0].id;
const emptyApplied = { hp: 0, xp: 0, gold: 0, danger: 0, levelUp: false, dead: false, location: null, quests: [], npcs: [], inventory: [], sceneObjects: [], conditions: { added: [], removed: [] }, rejected: [] };

type Gate = { promise: Promise<void>; open: () => void };
const gate = (): Gate => { let open!: () => void; return { promise: new Promise<void>(resolve => { open = resolve; }), open }; };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const clone = <T,>(value: T): T => structuredClone(value);

function committed(requestId: string, turnNumber: number, narration: string, playerAction = "Продолжить путь", withState = true) {
  return {
    ok: true as const, requestId, turnNumber, narration, playerAction, choices: [`Действие после хода ${turnNumber}`, "Осмотреться", "Подождать"], dice: null,
    outcome: "success", applied: emptyApplied, modelUsed: "gemini-test", taskType: "resolution", needsCompaction: false, dead: false, retrieved: [], skippedModels: [], warnings: [],
    ...(withState ? { state: { character: clone(mockSnapshot.session.character), worldState: clone(mockSnapshot.session.worldState) } } : {}),
  };
}

function snapshotAt(turnNumber: number, narration: string) {
  const snapshot = clone(mockSnapshot) as Omit<typeof mockSnapshot, "turns"> & { turns: Record<string, unknown>[] };
  snapshot.session.turnCount = turnNumber;
  snapshot.turns.push(
    { ...snapshot.turns[1], id: `20000000-0000-4000-8000-0000000000${turnNumber}a`, turnNumber, content: "Продолжить путь", requestId: `request-${turnNumber}` },
    { ...snapshot.turns[2], id: `20000000-0000-4000-8000-0000000000${turnNumber}b`, turnNumber, content: narration, requestId: `request-${turnNumber}`, choices: ["Идти дальше", "Осмотреться", "Подождать"] },
  );
  return snapshot;
}

async function configurePage(page: Page) {
  await installUiMock(page);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  return errors;
}

async function submit(page: Page, action: string) {
  await page.locator("#action-input").fill(action);
  await page.locator("#action-input").press("Control+Enter");
}

async function main() {
  const commitGates = new Map<string, Gate>();
  const requests: Record<string, Record<string, unknown>> = {};
  const committedScenarios = new Set<string>();
  const hungClosed = gate();
  const server = createServer(async (req, res) => {
    const scenario = new URL(req.url ?? "/", "http://mock").pathname.slice(1);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests[scenario] = JSON.parse(raw || "{}");
    res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
    const requestId = String(requests[scenario].requestId);
    res.write(`${JSON.stringify({ type: "stage", stage: "generation" })}\n`);
    res.write(`${JSON.stringify({ type: "narration", text: scenario === "hung" ? "Начало потерянного потока" : `Первые строки ${scenario}` })}\n`);
    if (scenario === "hung") {
      res.on("close", hungClosed.open);
      return;
    }
    await commitGates.get(scenario)?.promise;
    const turnNumber = scenario === "stream" || scenario === "hung" || scenario === "legacy" ? 4 : 5;
    committedScenarios.add(scenario);
    res.end(`${JSON.stringify({ type: "committed", result: committed(requestId, turnNumber, `Сохранённый рассказ ${scenario}`, String(requests[scenario].action), scenario !== "legacy") })}\n`);
  });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const mockAct = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch();
  try {
    // Real streamed preview, hidden item identity, two stateful commits ahead of a stale bulk refresh, and map edge.
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = await configurePage(page);
    const streamCommit = gate(); commitGates.set("stream", streamCommit);
    const refresh = gate();
    await page.route(`**/api/sessions/${mockSessionId}?*`, async route => {
      if (committedScenarios.has("stream")) await refresh.promise;
      await route.fulfill({ json: committedScenarios.has("stream") ? snapshotAt(4, "Сохранённый рассказ stream") : mockSnapshot });
    });
    let streamPosts = 0;
    const streamNextCommit = gate(); commitGates.set("stream-next", streamNextCommit);
    await page.route("**/act", route => route.continue({ url: `${mockAct}/${++streamPosts === 1 ? "stream" : "stream-next"}` }));
    await page.goto(`${base}/play/${mockSessionId}`);
    await page.getByRole("tab", { name: "Вещи", exact: true }).click();
    const item = page.locator(".gx-inv-item").filter({ hasText: "Карта побережья" });
    await item.getByRole("button", { name: "Добавить в действие" }).click();
    const action = page.locator("#action-input");
    await expect(action).toHaveValue("Использовать «Карта побережья»: ");
    assert.ok(!(await action.inputValue()).includes(itemId), "item UUID leaked into visible action text");
    await action.fill("Использовать «Карта побережья»: свериться с маршрутом");
    await action.press("Control+Enter");
    await expect(page.getByText("Первые строки stream", { exact: true })).toBeVisible();
    assert.deepEqual(requests.stream.itemIds, [itemId], "POST must retain hidden selected item identity");
    streamCommit.open();
    await expect(page.getByText("Сохранённый рассказ stream", { exact: true })).toBeVisible();
    await expect(action).toBeEnabled();
    await expect(item.getByRole("button", { name: "Добавить в действие" })).toBeDisabled();
    await submit(page, "Второе действие без ожидания панели");
    await expect(page.getByText("Первые строки stream-next", { exact: true })).toBeVisible();
    await expect(page.getByText("Ход сохранён · обновляем мир", { exact: true })).toHaveCount(0);
    streamNextCommit.open();
    await expect(page.getByText("Сохранённый рассказ stream-next", { exact: true })).toBeVisible();
    assert.equal(requests["stream-next"].expectedTurn, 4, "second turn must use the immediately committed turn number");
    refresh.open();
    await expect(action).toBeEnabled();
    await expect(page.getByText("Сохранённый рассказ stream-next", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "1 Действие после хода 5" })).toBeVisible();
    await page.getByRole("tab", { name: "Мир", exact: true }).click();
    await expect(page.locator(".gx-map-svg line").first()).toBeVisible();
    await mkdir("output/playwright", { recursive: true });
    await page.screenshot({ path: "output/playwright/turn-latency.png", fullPage: true, animations: "disabled" });
    assert.deepEqual(errors, [], `stream page errors: ${errors.join(" | ")}`);
    await page.close();

    // Failed bulk refresh still exposes retry, but authoritative response state keeps actions safe.
    const retryPage = await browser.newPage();
    const retryErrors = await configurePage(retryPage);
    const retryCommit = gate(); commitGates.set("retry", retryCommit); retryCommit.open();
    let failedPostCommitRefresh = false;
    await retryPage.route(`**/api/sessions/${mockSessionId}?*`, async route => {
      if (committedScenarios.has("retry") && !failedPostCommitRefresh) {
        failedPostCommitRefresh = true;
        await route.fulfill({ status: 503, json: { message: "refresh failed" } });
      } else await route.fulfill({ json: committedScenarios.has("retry") ? snapshotAt(5, "Сохранённый рассказ retry") : mockSnapshot });
    });
    await retryPage.route("**/act", route => route.continue({ url: `${mockAct}/retry` }));
    await retryPage.goto(`${base}/play/${mockSessionId}`);
    await submit(retryPage, "Проверить неустойчивую связь");
    await expect(retryPage.getByText("Сохранённый рассказ retry", { exact: true })).toBeVisible();
    await expect(retryPage.getByRole("button", { name: "Обновить сцену" })).toBeVisible();
    await expect(retryPage.locator("#action-input")).toBeEnabled();
    await retryPage.getByRole("button", { name: "Обновить сцену" }).click();
    await expect(retryPage.locator("#action-input")).toBeEnabled();
    await expect(retryPage.getByText("Ход сохранён. Не удалось обновить состояние мира", { exact: false })).toHaveCount(0);
    assert.deepEqual(retryErrors, [], `retry page errors: ${retryErrors.join(" | ")}`);
    await retryPage.close();

    // Legacy committed responses have no authoritative state and retain the snapshot gate.
    const legacyPage = await browser.newPage();
    const legacyErrors = await configurePage(legacyPage);
    const legacyCommit = gate(); commitGates.set("legacy", legacyCommit); legacyCommit.open();
    const legacyRefresh = gate();
    await legacyPage.route(`**/api/sessions/${mockSessionId}?*`, async route => {
      if (committedScenarios.has("legacy")) await legacyRefresh.promise;
      await route.fulfill({ json: committedScenarios.has("legacy") ? snapshotAt(4, "Сохранённый рассказ legacy") : mockSnapshot });
    });
    await legacyPage.route("**/act", route => route.continue({ url: `${mockAct}/legacy` }));
    await legacyPage.goto(`${base}/play/${mockSessionId}`);
    await submit(legacyPage, "Старый формат ответа");
    await expect(legacyPage.getByText("Сохранённый рассказ legacy", { exact: true })).toBeVisible();
    await expect(legacyPage.locator("#action-input")).toBeDisabled();
    legacyRefresh.open();
    await expect(legacyPage.locator("#action-input")).toBeEnabled();
    assert.deepEqual(legacyErrors, [], `legacy page errors: ${legacyErrors.join(" | ")}`);
    await legacyPage.close();

    // A completed ledger poll must finish and abort a still-open stream.
    const hungPage = await browser.newPage();
    const hungErrors = await configurePage(hungPage);
    let hungRequestId = "";
    await hungPage.route("**/act", async route => {
      const body = route.request().postDataJSON(); hungRequestId = body.requestId;
      await route.continue({ url: `${mockAct}/hung` });
    });
    await hungPage.route("**/requests/*", route => route.fulfill({ json: { requestId: hungRequestId, status: "completed", stage: "completed", baseTurn: 3, retryAfter: 0, error: null, result: committed(hungRequestId, 4, "Восстановлено опросом", "Дождаться ответа") } }));
    await hungPage.route(`**/api/sessions/${mockSessionId}?*`, route => route.fulfill({ json: hungRequestId ? snapshotAt(4, "Восстановлено опросом") : mockSnapshot }));
    await hungPage.goto(`${base}/play/${mockSessionId}`);
    await submit(hungPage, "Дождаться ответа");
    await expect.poll(() => Boolean(requests.hung)).toBe(true);
    await expect(hungPage.getByText("Восстановлено опросом", { exact: true })).toBeVisible({ timeout: 8_000 });
    await expect(hungPage.locator("#action-input")).toBeEnabled();
    await Promise.race([hungClosed.promise, sleep(3_000).then(() => { throw new Error("completed polling did not abort the active stream"); })]);
    assert.deepEqual(hungErrors, [], `hung page errors: ${hungErrors.join(" | ")}`);
    await hungPage.close();

    // A delayed initial N snapshot must not overwrite recovery state N+1.
    const stalePage = await browser.newPage();
    const staleErrors = await configurePage(stalePage);
    const initialGet = gate(); let recoveryPolled = false;
    const recovered = committed("restored-request", 4, "Восстановленный новый ход", "Сохранённое действие");
    await stalePage.addInitScript(({ sessionId }) => sessionStorage.setItem(`chronicle:pending:${sessionId}`, JSON.stringify({ id: "restored-request", sessionId, action: "Сохранённое действие", custom: true, expectedTurn: 3 })), { sessionId: mockSessionId });
    await stalePage.route(`**/api/sessions/${mockSessionId}?*`, async route => {
      const isInitial = !recoveryPolled;
      if (isInitial) await initialGet.promise;
      await route.fulfill({ json: isInitial ? mockSnapshot : snapshotAt(4, "Восстановленный новый ход") });
    });
    await stalePage.route("**/requests/*", route => { recoveryPolled = true; return route.fulfill({ json: { requestId: "restored-request", status: "completed", stage: "completed", baseTurn: 3, retryAfter: 0, error: null, result: recovered } }); });
    await stalePage.goto(`${base}/play/${mockSessionId}`, { waitUntil: "domcontentloaded" });
    await expect(stalePage.getByText("Восстановленный новый ход", { exact: true })).toBeVisible({ timeout: 8_000 });
    initialGet.open();
    await sleep(250);
    await expect(stalePage.getByText("Восстановленный новый ход", { exact: true })).toBeVisible();
    await expect(stalePage.locator("#action-input")).toBeEnabled();
    assert.deepEqual(staleErrors, [], `stale page errors: ${staleErrors.join(" | ")}`);
    await stalePage.close();

    console.log("PASS: streamed latency, hidden item bindings, refresh recovery, hung-stream polling, version guard, and map edge");
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
