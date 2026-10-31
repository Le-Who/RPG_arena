/** Actual AppShell, Overview and StoryCreator in Chromium; synthetic HTTP only, no .env/database/provider. */
import { chromium, expect, type Page, type Route } from "@playwright/test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { settings } from "./ui-mock";
import { DEFAULT_READING } from "../src/lib/reading-preferences";
import type { IdentityView } from "../src/lib/ui-identity";

const output = resolve("output/playwright/workspace-latency");
const profileA = "guest:workspace-latency-a", profileB = "guest:workspace-latency-b";
function identity(profileId: string): IdentityView {
  return { kind: "guest", profileId, account: null, guestProfileId: profileId, isAdmin: false, capabilities: { administration: false }, pendingGuestCampaigns: 0, passwordRecoveryAvailable: false };
}
function bootstrap(profileId = profileA, displayName = "Первое пространство") {
  return { ok: true, identity: identity(profileId), sessions: [], settings, workspace: { id: profileId, displayName, favorites: [], reading: { ...DEFAULT_READING, motion: "reduced" } } };
}
type Result = { name: string; viewport: string; status: "passed" | "failed"; error?: string; requests: string[]; browserErrors: string[] };
type FixtureWindow = Window & { originRefresh?: Promise<boolean>; newerRefresh?: Promise<boolean>; workspaceFixture: { refresh: (expectedProfileId?: string) => Promise<boolean>; applyIdentityChange: (identity: IdentityView) => Promise<void>; acceptSettings: (value: typeof settings, profileId: string) => void } };

async function keyboardActivate(page: Page, name: string) {
  await page.getByRole("button", { name, exact: true }).first().focus();
  await page.keyboard.press("Enter");
}
async function state(page: Page) { return JSON.parse(await page.getByTestId("workspace-fixture-state").textContent() ?? "null") as { profileId: string | null; displayName: string; loading: boolean; model: string | null }; }
function oneBootstrap(requests: string[], count = 1) { expect(requests).toEqual(Array.from({ length: count }, () => "GET /api/bootstrap")); }

async function main() {
  await mkdir(output, { recursive: true });
  const bundle = await build({ stdin: { contents: `
    import React,{useEffect} from "react";
    import {createRoot} from "react-dom/client";
    import {AppShell,useApp} from "./src/components/app-shell";
    import {Overview} from "./src/components/overview";
    import {CampaignCopyButton} from "./src/components/campaign-copy-button";
    function Fixture(){const app=useApp();useEffect(()=>{window.workspaceFixture=app;},[app]);return <><Overview/><CampaignCopyButton sessionId="public-fixture"/><output hidden data-testid="workspace-fixture-state">{JSON.stringify({profileId:app.identity?.profileId??null,displayName:app.workspace.displayName,loading:app.loading,model:app.settings?.narrationModel??null})}</output></>;}
    createRoot(document.getElementById("root")).render(<AppShell><Fixture/></AppShell>);
  `, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, outdir: "fixture", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "isolated-environment", setup(builder) {
    builder.onResolve({ filter: /^(next\/link|next\/image|next\/navigation|\.\/settings-overlay|\.\/command-palette|\.\/pwa|\.\/app-update)$/ }, args => ({ path: args.path, namespace: "fixture-environment" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture-environment" }, args => ({ loader: "tsx", resolveDir: process.cwd(), contents:
      args.path === "next/link" ? 'import React from "react"; export default function Link(props){return <a {...props}/>;}' :
      args.path === "next/image" ? 'import React from "react";export default function Image({fill,priority,quality,placeholder,blurDataURL,style,...props}){return <img {...props} style={fill?{position:"absolute",height:"100%",width:"100%",inset:0,...style}:style}/>;}' :
      args.path === "next/navigation" ? 'const router={push:url=>history.pushState({},"",url),replace:url=>history.replaceState({},"",url),refresh:()=>{}};export const useRouter=()=>router;export const usePathname=()=>"/";' :
      args.path === "./settings-overlay" ? 'export const SettingsOverlay=()=>null;' :
      args.path === "./command-palette" ? 'export const CommandPalette=()=>null;' :
      args.path === "./pwa" ? 'export const InstallAppButton=()=>null;' :
      'import React from "react";export const AppUpdateProvider=({children})=><>{children}</>;export const useAppUpdateGuard=()=>null;'
    }));
  } }] });
  const css = (await Promise.all(["x3", "globals", "shell", "pages", "theatre", "preferences", "dialogs", "overview", "life", "pwa"].map(name => readFile(`src/app/${name}.css`, "utf8")))).join("\n").replace('@import "tailwindcss";', "");
  const html = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><body><div id="root"></div><script src="/fixture.js"></script></body></html>';
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : req.url === "/fixture.css" ? "text/css" : "text/html");
    res.end(req.url === "/fixture.js" ? bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text : req.url === "/fixture.css" ? css : html);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch().catch(async error => { await new Promise<void>(done => server.close(() => done())); throw error; });
  const results: Result[] = [];
  try {
    for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "mobile", width: 390, height: 844 }]) {
      for (const name of ["pending-draft", "focus-identity-race", "settings-save-race", "profile-change-after-save", "revoked-session", "error-retry", "refresh-origin-fence", "initial-create-same-owner", "initial-create-changed-owner", "initial-create-before-bootstrap", "initial-copy-same-owner", "initial-copy-changed-owner"]) {
        const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
        page.setDefaultTimeout(5000);
        const result: Result = { name, viewport: viewport.name, status: "passed", requests: [], browserErrors: [] };
        const pending: Route[] = [];
        const creations: Route[] = [];
        let held = name === "pending-draft" || name.startsWith("initial-"), failNext = name === "error-retry";
        let current = bootstrap();
        page.on("pageerror", error => result.browserErrors.push(error.message));
        await page.route("**/*", async route => {
          const url = new URL(route.request().url());
          if (url.origin !== base) return route.abort();
          if (!url.pathname.startsWith("/api/")) {
            if (/\.(webp|png|jpg|svg)$/.test(url.pathname)) return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="1456" height="816"><rect width="100%" height="100%" fill="#211934"/></svg>' });
            return route.continue();
          }
          result.requests.push(`${route.request().method()} ${url.pathname}`);
          if (["/api/sessions", "/api/sessions/public-fixture/copy"].includes(url.pathname) && route.request().method() === "POST") { creations.push(route); return; }
          if (url.pathname === "/api/bootstrap") {
            if (held) { pending.push(route); return; }
            if (failNext) { failNext = false; return route.fulfill({ status: 503, json: { message: "Тест: пространство временно недоступно" } }); }
            return route.fulfill({ json: current });
          }
          // Respond to the old contract so the preserved red report diagnoses its request waterfall.
          if (url.pathname === "/api/auth/me") return route.fulfill({ json: { ok: true, identity: current.identity } });
          if (url.pathname === "/api/sessions") return route.fulfill({ json: { sessions: [] } });
          if (url.pathname === "/api/settings") return route.fulfill({ json: current.settings });
          if (url.pathname === "/api/workspace") return route.fulfill({ json: current.workspace });
          result.browserErrors.push(`Unexpected fixture API: ${route.request().method()} ${url.pathname}`);
          return route.fulfill({ status: 501, json: { message: "Нет тестового ответа" } });
        });
        try {
          await page.goto(base);
          await expect(page.getByRole("heading", { name: "Хороший день для новой истории." })).toBeVisible();
          await expect.poll(() => result.requests.length).toBeGreaterThan(0);
          if (name.startsWith("initial-")) {
            const copying = name.startsWith("initial-copy-");
            if (!copying) await keyboardActivate(page, "Новая история");
            await keyboardActivate(page, copying ? "Продолжить в своей копии" : "Начать историю");
            await expect.poll(() => creations.length).toBe(1);
            if (name.endsWith("changed-owner")) current = bootstrap(profileB, "Второе пространство");
            if (name === "initial-create-before-bootstrap") {
              await creations.shift()!.fulfill({ json: { session: { id: "created-story", ownerId: profileA } } });
              await expect.poll(() => pending.length).toBe(2);
              await pending.pop()!.fulfill({ json: current });
              await pending.shift()!.fulfill({ json: current }); held = false;
            } else {
              await pending.shift()!.fulfill({ json: current }); held = false;
              await expect.poll(async () => (await state(page)).profileId).toBe(current.identity.profileId);
              await creations.shift()!.fulfill({ json: { session: { id: "created-story", ownerId: profileA } } });
            }
            if (!name.endsWith("changed-owner")) await expect.poll(() => new URL(page.url()).pathname).toBe("/play/created-story");
            else {
              await expect(page.getByRole("button", { name: copying ? "Продолжить в своей копии" : "Начать историю" })).toBeEnabled();
              expect(new URL(page.url()).pathname).toBe("/");
            }
          } else if (name === "refresh-origin-fence") {
            await expect.poll(async () => (await state(page)).loading).toBe(false);
            expect(await page.evaluate(profile => (window as unknown as FixtureWindow).workspaceFixture.refresh(profile), profileA)).toBe(true);
            failNext = true;
            expect(await page.evaluate(profile => (window as unknown as FixtureWindow).workspaceFixture.refresh(profile), profileA)).toBe(true);
            held = true;
            await page.evaluate(profile => { const fixture = window as unknown as FixtureWindow; fixture.originRefresh = fixture.workspaceFixture.refresh(profile); }, profileA);
            await expect.poll(() => pending.length).toBe(1);
            await page.evaluate(profile => { const fixture = window as unknown as FixtureWindow; fixture.newerRefresh = fixture.workspaceFixture.refresh(profile); }, profileA);
            await expect.poll(() => pending.length).toBe(2);
            await pending.shift()!.fulfill({ json: current });
            expect(await page.evaluate(() => (window as unknown as FixtureWindow).originRefresh)).toBe(true);
            await pending.shift()!.fulfill({ json: current });
            expect(await page.evaluate(() => (window as unknown as FixtureWindow).newerRefresh)).toBe(true);
            await page.evaluate(profile => { const fixture = window as unknown as FixtureWindow; fixture.originRefresh = fixture.workspaceFixture.refresh(profile); }, profileA);
            await expect.poll(() => pending.length).toBe(1);
            await page.evaluate(profile => { const fixture = window as unknown as FixtureWindow; fixture.newerRefresh = fixture.workspaceFixture.refresh(profile); }, profileA);
            await expect.poll(() => pending.length).toBe(2);
            await pending.shift()!.fulfill({ status: 401, json: { code: "UNAUTHORIZED", message: "Сеанс завершён" } });
            expect(await page.evaluate(() => (window as unknown as FixtureWindow).originRefresh)).toBe(false);
            expect((await state(page)).profileId).toBe(profileA);
            await pending.shift()!.fulfill({ json: current });
            expect(await page.evaluate(() => (window as unknown as FixtureWindow).newerRefresh)).toBe(true);
            expect((await state(page)).profileId).toBe(profileA);
            held = false;
            current = bootstrap(profileB, "Второе пространство");
            expect(await page.evaluate(profile => (window as unknown as FixtureWindow).workspaceFixture.refresh(profile), profileA)).toBe(false);
            await expect.poll(async () => (await state(page)).profileId).toBe(profileB);
            const count = result.requests.length;
            expect(await page.evaluate(profile => (window as unknown as FixtureWindow).workspaceFixture.refresh(profile), profileA)).toBe(false);
            expect(result.requests.length).toBe(count);
            expect(await page.evaluate(profile => (window as unknown as FixtureWindow).workspaceFixture.refresh(profile), profileB)).toBe(true);
          } else if (name === "pending-draft") {
            oneBootstrap(result.requests);
            await expect(page.getByRole("status")).toContainText("Загружаем ваши истории");
            await keyboardActivate(page, "Как это работает");
            await expect(page.getByRole("dialog")).toContainText("Здесь нет неправильного пути");
            await page.keyboard.press("Escape");
            await expect(page.getByRole("button", { name: "Как это работает", exact: true }).first()).toBeFocused();
            await keyboardActivate(page, "Новая история");
            await keyboardActivate(page, "Своя история");
            const title = page.getByRole("textbox", { name: "Название истории" });
            await title.focus(); await page.keyboard.type("Чай в осеннем городе");
            await page.keyboard.press("Tab");
            await expect(page.getByRole("textbox", { name: "Мир или место" })).toBeFocused();
            expect((await state(page)).loading).toBe(true);
            await expect(page.getByRole("dialog")).toBeInViewport();
            await page.screenshot({ path: `${output}/${viewport.name}-while-pending.png`, animations: "disabled" });
            expect(pending).toHaveLength(1); await pending.shift()!.fulfill({ json: current }); held = false;
            await expect.poll(async () => (await state(page)).loading).toBe(false);
            await expect(title).toHaveValue("Чай в осеннем городе");
            await expect(page.getByRole("textbox", { name: "Мир или место" })).toBeFocused();
            await page.keyboard.type("Киев");
            await expect(page.getByRole("textbox", { name: "Мир или место" })).toHaveValue("Киев");
            await page.keyboard.press("Escape");
            await expect(page.getByRole("button", { name: "Новая история", exact: true })).toBeFocused();
            oneBootstrap(result.requests);
          } else if (name === "focus-identity-race") {
            await expect.poll(async () => (await state(page)).loading).toBe(false);
            oneBootstrap(result.requests);
            held = true;
            await page.evaluate(() => window.dispatchEvent(new Event("focus")));
            await expect.poll(() => pending.length).toBe(1);
            const stale = pending.shift()!;
            held = false; current = bootstrap(profileB, "Второе пространство");
            await page.evaluate(next => { void (window as unknown as FixtureWindow).workspaceFixture.applyIdentityChange(next); }, identity(profileB));
            await expect.poll(async () => (await state(page)).displayName).toBe("Второе пространство");
            await stale.fulfill({ json: bootstrap(profileA, "Устаревшее пространство") });
            await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
            expect(await state(page)).toMatchObject({ profileId: profileB, displayName: "Второе пространство", loading: false });
            oneBootstrap(result.requests, 3);
            await page.evaluate(({ value, profileId }) => (window as unknown as FixtureWindow).workspaceFixture.acceptSettings(value, profileId), { value: { ...settings, narrationModel: "stale-model" }, profileId: profileA });
            expect((await state(page)).model).not.toBe("stale-model");
            await page.evaluate(({ value, profileId }) => (window as unknown as FixtureWindow).workspaceFixture.acceptSettings(value, profileId), { value: { ...settings, narrationModel: "accepted-model" }, profileId: profileB });
            await expect.poll(async () => (await state(page)).model).toBe("accepted-model");
          } else if (name === "revoked-session") {
            await expect.poll(async () => (await state(page)).loading).toBe(false);
            expect((await state(page)).profileId).toBe(profileA);
            held = true;
            await page.evaluate(() => window.dispatchEvent(new Event("focus")));
            await expect.poll(() => pending.length).toBe(1);
            await pending.shift()!.fulfill({ status: 401, json: { code: "IDENTITY_CHANGED", message: "Профиль изменился. Обновите страницу." } });
            await expect.poll(async () => (await state(page)).profileId).toBeNull();
            expect(await state(page)).toMatchObject({ model: null, displayName: "Искатель историй" });
            await expect(page.getByText("Первое пространство", { exact: true })).toHaveCount(0);
            oneBootstrap(result.requests, 2);
          } else if (name === "settings-save-race" || name === "profile-change-after-save") {
            await expect.poll(async () => (await state(page)).loading).toBe(false);
            oneBootstrap(result.requests);
            held = true;
            await page.evaluate(() => window.dispatchEvent(new Event("focus")));
            await expect.poll(() => pending.length).toBe(1);
            await page.evaluate(({ value, profileId }) => (window as unknown as FixtureWindow).workspaceFixture.acceptSettings(value, profileId), { value: { ...settings, narrationModel: "saved-during-refresh" }, profileId: profileA });
            await expect.poll(async () => (await state(page)).model).toBe("saved-during-refresh");
            if (name === "profile-change-after-save") current = bootstrap(profileB, "Второе пространство");
            await pending.shift()!.fulfill({ json: current }); held = false;
            await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
            expect((await state(page)).model).toBe(name === "profile-change-after-save" ? settings.narrationModel : "saved-during-refresh");
            if (name === "profile-change-after-save") expect((await state(page)).profileId).toBe(profileB);
            oneBootstrap(result.requests, 2);
          } else {
            await expect(page.getByRole("alert")).toContainText("Тест: пространство временно недоступно");
            await keyboardActivate(page, "Повторить");
            await expect(page.getByRole("alert")).toHaveCount(0);
            await expect.poll(async () => (await state(page)).displayName).toBe("Первое пространство");
            oneBootstrap(result.requests, 2);
          }
          expect(result.browserErrors).toEqual([]);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
          await page.screenshot({ path: `${output}/${viewport.name}-${name}.png`, fullPage: false });
        } catch (error) { result.status = "failed"; result.error = error instanceof Error ? error.message : String(error); await page.screenshot({ path: `${output}/${viewport.name}-${name}-failed.png` }).catch(() => {}); }
        results.push(result);
        console.log(`${result.status.toUpperCase()} ${viewport.name} ${name}${result.error ? `: ${result.error}` : ""}`);
        for (const route of pending) await route.abort().catch(() => {});
        await page.close();
      }
    }
  } finally { await browser.close(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
  const report = JSON.stringify({ generatedAt: new Date().toISOString(), stubs: ["Next Link/image/router", "settings/search overlays", "PWA and app update provider"], actual: ["AppShell", "Overview", "WorldLibrary", "StoryCreator", "Dialog", "api-client"], results }, null, 2);
  await writeFile(`${output}/result.json`, report);
  await writeFile(`${output}/original-result.json`, report, { flag: "wx" }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  if (results.some(result => result.status === "failed")) process.exitCode = 1;
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
