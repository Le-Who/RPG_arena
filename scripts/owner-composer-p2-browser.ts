/** Actual PlayRoom in isolated Chromium: synthetic HTTP canon, no Next server, database or provider. */
import { chromium, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { mockSnapshot, mockSessionId, settings } from "./ui-mock";

const output = resolve("output/playwright/owner-composer-p2");
const reportOutput = resolve("output/p2-ui-persistence-coverage");
const sessionPath = `/api/sessions/${mockSessionId}`;
const slot = { id: "owner-slot", npcKey: "mara", npcName: "Мара", place: "Тихая гавань", from: 540, to: 1080, repeat: "daily", day: null, note: "Старое окно", createdTurn: 3, source: "owner" };
const commitment = { id: "owner-meeting", title: "Чай с Марой", parties: ["Мара"], place: "Тихая гавань", due: { day: 2, minute: 720 }, status: "accepted", createdTurn: 2, updatedTurn: 3, note: "Без спешки", revision: 0, history: [] };
const story = { kind: "arc", status: "resolved", goal: "Собрать друзей", stakes: "Дружба", conflict: "Расстояние", endCondition: "Все за столом", focus: [], resolvedTurn: 3, epilogue: "Друзья встретились." };
function snapshot() {
  const data = structuredClone(mockSnapshot);
  return { ...data, isOwner: true, npcs: data.npcs.map(npc => ({ ...npc, key: "mara" })), sceneObjects: data.sceneObjects.map(object => ({ ...object, key: "letter" })), session: { ...data.session, updatedAt: new Date().toISOString(), worldState: { ...data.session.worldState, clock: { day: 2, minute: 600 }, story, commitments: [commitment], npcSchedules: [slot], npcBonds: [{ key: "mara", name: "Мара", history: [], knows: [{ text: "Знает пристань", turn: 1 }], updatedTurn: 3 }] } } };
}
type Fixture = ReturnType<typeof snapshot>;
type Result = { name: string; viewport: string; status: "passed" | "failed"; error?: string; requests: unknown[]; browserErrors: string[]; focus?: unknown };

async function main() {
  await mkdir(output, { recursive: true }); await mkdir(reportOutput, { recursive: true });
  const app = `const app = {settings:${JSON.stringify(settings)}, sessions:[], identity:{profileId:${JSON.stringify(mockSnapshot.session.ownerId)}}, workspace:{reading:{motion:"reduced"}}, refresh:async()=>{}, notify:()=>{}, resolveNotification:()=>{},setPlayCommands:()=>{}}; export const useApp=()=>app;`;
  const bundle = await build({ stdin: { contents: `import React from "react"; import {createRoot} from "react-dom/client"; import {PlayRoom} from "./src/components/play-room"; createRoot(document.getElementById("root")).render(<PlayRoom sessionId="${mockSessionId}"/>);`, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, outdir: "fixture", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "environment-only", setup(builder) {
    builder.onResolve({ filter: /^(next\/link|next\/navigation|\.\/app-shell|\.\/app-update)$/ }, args => ({ path: args.path, namespace: "fixture-environment" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture-environment" }, args => ({ loader: "tsx", resolveDir: process.cwd(), contents: args.path === "./app-shell" ? app : args.path === "./app-update" ? "export const useAppUpdateGuard=()=>null;" : args.path === "next/link" ? 'import React from "react"; export default function Link(props){return <a {...props}/>;}' : "export const useRouter=()=>({push:()=>{},refresh:()=>{}});" }));
  } }] });
  const css = (await Promise.all(["globals", "shell", "theatre", "x3", "life", "dialogs"].map(name => readFile(`src/app/${name}.css`, "utf8")))).join("\n").replace('@import "tailwindcss";', "") + (bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "");
  const html = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><body><main id="root"></main><script src="/fixture.js"></script></body></html>';
  const server = createServer((req, res) => { res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : req.url === "/fixture.css" ? "text/css" : "text/html"); res.end(req.url === "/fixture.js" ? bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text : req.url === "/fixture.css" ? css : html); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch().catch(async error => {
    await new Promise<void>((done, reject) => server.close(closeError => closeError ? reject(closeError) : done()));
    throw error;
  });
  const results: Result[] = [];
  try {
    for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "mobile", width: 390, height: 844 }]) {
      for (const name of ["composer-retain", "composer-remove", "social", "commitment", "arc", "social-focus-moved", "commitment-focus-moved", "arc-focus-moved", "social-focus-inside"]) {
        const flow = name.replace(/-focus-(moved|inside)$/, ""), keepFocus = name.includes("-focus-");
        const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
        const errors: string[] = [], requests: unknown[] = [];
        const result: Result = { name, viewport: viewport.name, status: "passed", requests, browserErrors: errors };
        let canon: Fixture = snapshot();
        let releaseMutation!: () => void;
        const mutationGate = new Promise<void>(done => { releaseMutation = done; });
        const protectedLink = () => page.getByRole("link", { name: name === "social-focus-inside" ? "ход 1" : "Скачать кампанию JSON", exact: true });
        const preserveUserFocus = async () => {
          if (!keepFocus) return;
          await expect.poll(() => requests.filter(r => (r as {method:string}).method === "PATCH").length).toBe(1);
          await protectedLink().focus(); releaseMutation();
        };
        page.on("pageerror", error => errors.push(error.message));
        await page.route("**/*", async route => {
          const url = new URL(route.request().url());
          if (url.origin !== base) return route.abort();
          if (!url.pathname.startsWith("/api/")) return route.continue();
          const method = route.request().method();
          const body = method === "GET" ? undefined : route.request().postDataJSON();
          requests.push({ method, path: url.pathname, body });
          if (url.pathname === sessionPath && method === "GET") return route.fulfill({ json: canon });
          if (url.pathname === `${sessionPath}/recap` && method === "GET") return route.fulfill({ json: { recap: { headline: "Ранее: встреча в гавани", awayLabel: "давно", sections: [{ id: "where", title: "Где мы", lines: ["Тихая гавань"] }], markdown: "Тихая гавань", finished: true } } });
          if (url.pathname === `${sessionPath}/social` && method === "PATCH") {
            if (keepFocus) await mutationGate;
            canon.session.worldState.npcSchedules = [{ ...slot, place: "Кафе у моря", from: 660, to: 780, note: "Канон: стол у окна" }];
            return route.fulfill({ json: { ok: true, world: canon.session.worldState, summary: "Распорядок уточнён" } });
          }
          if (url.pathname === `${sessionPath}/commitments` && method === "PATCH") {
            if (keepFocus) await mutationGate;
            canon.session.worldState.commitments = [{ ...commitment, due: { day: 5, minute: 1005 }, updatedTurn: 3, revision: 1, note: "Канон: новая встреча", history: [] }];
            return route.fulfill({ json: { ok: true, world: canon.session.worldState, summary: "Срок уточнён" } });
          }
          if (url.pathname === sessionPath && method === "PATCH") {
            if (keepFocus) await mutationGate;
            canon.session.worldState.story = { kind: "arc", status: "ongoing", goal: "Канон: открыть чайную", stakes: "Общий дом", conflict: "Ремонт", endCondition: "Первая чашка гостю", focus: [], resolvedTurn: 3, epilogue: "" };
            return route.fulfill({ json: { ok: true, session: canon.session } });
          }
          if (url.pathname === `${sessionPath}/act` && method === "POST") return route.fulfill({ status: 422, json: { ok: false, code: "INVALID_INPUT", message: "Тест: действие записано, модель не вызывается" } });
          if (url.pathname.startsWith(`${sessionPath}/requests/`) && method === "GET") return route.fulfill({ status: 404, json: { code: "NOT_FOUND", message: "Тестовый запрос ещё не принят" } });
          errors.push(`Unhandled fixture API: ${method} ${url.pathname}`);
          return route.fulfill({ status: 501, json: { error: "Нет явного тестового ответа" } });
        });
        try {
          await page.goto(base);
          const input = page.getByRole("textbox", { name: "Ваше действие", exact: true });
          await expect(input).toBeEnabled();
          await expect(page.getByRole("button", { name: "Сделать ход", exact: true })).toBeDisabled();
          if (name.startsWith("composer")) {
            await input.fill("Показываю Кар");
            await expect(page.getByRole("option", { name: "Карта побережья Вещь" })).toBeVisible();
            await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowUp"); await page.keyboard.press("Enter");
            await expect(input).toHaveValue("Показываю «Карта побережья»"); await expect(input).toBeFocused();
            await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())));
            await page.keyboard.press("End"); await page.keyboard.type(" Маре у воды");
            if (name === "composer-remove") await input.fill("Приветствую Мару у воды");
            await page.keyboard.press("Control+Enter");
            await expect.poll(() => requests.filter((r: unknown) => (r as {path:string}).path === `${sessionPath}/act`).length).toBe(1);
            const sent = requests.find((r: unknown) => (r as {path:string}).path === `${sessionPath}/act`) as {body:Record<string,unknown>};
            expect(sent.body).toEqual({ action: name === "composer-retain" ? "Показываю «Карта побережья» Маре у воды" : "Приветствую Мару у воды", custom: true, expectedTurn: 3, requestId: expect.any(String), ...(name === "composer-retain" ? { itemIds: ["40000000-0000-4000-8000-000000000001"] } : {}) });
            expect(sent.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
          } else if (flow === "social") {
            await chooseTab(page, "Мир"); await page.getByText("Связь и распорядок", { exact: true }).click();
            const edit = page.getByRole("button", { name: "Изменить окно «Тихая гавань», 09:00–18:00, ежедневно", exact: true });
            await edit.focus(); await page.keyboard.press("Enter");
            await page.getByLabel("Место", { exact: true }).fill("Кафе у моря"); await page.getByLabel("С", { exact: true }).fill("11:00"); await page.getByLabel("До", { exact: true }).fill("13:00"); await page.getByLabel("Заметка", { exact: true }).fill("Стол у окна");
            await keyboardSubmit(page, "Сохранить");
            await preserveUserFocus();
            await expect(page.locator(".sx-slots")).toContainText("«Кафе у моря», 11:00–13:00, ежедневно — Канон: стол у окна");
            await expect(page.getByLabel("Место", { exact: true })).toHaveCount(0);
            expect(mutation(requests, "/social")).toEqual({ op: "schedule.upsert", id: "owner-slot", expected: '["owner-slot","mara","Мара","Тихая гавань",540,1080,"daily",null,"Старое окно",3,"owner"]', npcKey: "mara", place: "Кафе у моря", from: "11:00", to: "13:00", repeat: "daily", day: null, note: "Стол у окна" });
            expect(errors).toEqual([]);
            await expect(keepFocus ? protectedLink() : page.locator(".sx-bond summary")).toBeFocused();
          } else if (flow === "commitment") {
            await chooseTab(page, "Жизнь"); const opener = page.getByRole("button", { name: "Перенести", exact: true }); await opener.focus(); await page.keyboard.press("Enter");
            await page.getByLabel("День", { exact: true }).fill("4"); await page.getByLabel("Время", { exact: true }).fill("15:30"); await keyboardSubmit(page, "Сохранить срок");
            await preserveUserFocus();
            await expect(page.locator(".lx-commit")).toContainText("День 5, 16:45"); await expect(page.getByLabel("День", { exact: true })).toHaveCount(0);
            expect(mutation(requests, "/commitments")).toEqual({ id: "owner-meeting", version: "ff2096a17f9f2810460d51e332b575797eb1ee3a468ac5f0cf1e143ddac64e9e", action: "reschedule", day: 4, time: "15:30" });
            expect(errors).toEqual([]);
            await expect(keepFocus ? protectedLink() : opener).toBeFocused();
            await opener.focus(); await page.keyboard.press("Enter");
            await expect(page.getByLabel("День", { exact: true })).toHaveValue("5"); await expect(page.getByLabel("Время", { exact: true })).toHaveValue("16:45");
          } else {
            const opener = page.getByRole("button", { name: "Новая арка", exact: true }); await opener.focus(); await page.keyboard.press("Enter");
            await page.getByLabel("Новая цель", { exact: true }).fill("Открыть чайную"); await page.getByLabel("Ставки", { exact: true }).fill("Общий дом"); await page.getByLabel("Конфликт", { exact: true }).fill("Ремонт"); await page.getByLabel("Финал, когда", { exact: true }).fill("Первая чашка гостю"); await keyboardSubmit(page, "Начать арку");
            await preserveUserFocus();
            await expect(page.locator(".ax-finale")).toHaveCount(0); await expect(page.getByLabel("Новая цель", { exact: true })).toHaveCount(0);
            expect(mutation(requests, "")).toEqual({ storyShape: { continueAs: "arc", goal: "Открыть чайную", stakes: "Общий дом", conflict: "Ремонт", endCondition: "Первая чашка гостю" } });
            expect(errors).toEqual([]);
            await expect(keepFocus ? protectedLink() : input).toBeFocused();
            await chooseTab(page, "Жизнь"); await expect(page.locator(".lx-shape.is-arc")).toContainText("Канон: открыть чайную"); await expect(page.locator(".lx-shape.is-arc")).toContainText("Первая чашка гостю");
          }
          expect(errors).toEqual([]);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        } catch (error) { result.status = "failed"; result.error = error instanceof Error ? error.message : String(error); }
        result.focus = await page.evaluate(() => ({ tag: document.activeElement?.tagName, text: document.activeElement?.textContent?.slice(0, 120), id: document.activeElement?.id }));
        results.push(result); console.log(`${result.status.toUpperCase()} ${viewport.name} ${name}${result.error ? `: ${result.error}` : ""}`);
        await page.screenshot({ path: `${output}/${viewport.name}-${name}.png`, fullPage: false }).catch(error => { result.status = "failed"; result.error = `Screenshot failed: ${String(error)}`; console.error(result.error); });
        await page.close();
      }
    }
  } finally { await browser.close(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
  const serialized = JSON.stringify({ generatedAt: new Date().toISOString(), stubs: ["useApp context with fixed owner/settings", "app update guard", "Next Link/router navigation"], results }, null, 2);
  await writeFile(`${output}/result.json`, serialized);
  await writeFile(`${output}/original-result.json`, serialized, { flag: "wx" }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  if (results.some(result => result.status === "failed")) process.exitCode = 1;
}
function mutation(requests: unknown[], suffix: string) { const matches = requests.filter(r => { const request = r as {method:string;path:string}; return request.method === "PATCH" && request.path === sessionPath + suffix; }) as {body:unknown}[]; expect(matches).toHaveLength(1); return matches[0].body; }
async function chooseTab(page: Page, name: string) { const tab = page.getByRole("tab", { name, exact: true }); await tab.focus(); await page.keyboard.press("Enter"); await expect(tab).toHaveAttribute("aria-selected", "true"); }
async function keyboardSubmit(page: Page, name: string) { await page.getByRole("button", { name, exact: true }).focus(); await page.keyboard.press("Enter"); }
void main().catch(error => { console.error(error); process.exitCode = 1; });
