/** Actual Dialog in isolated browsers: background semantics and layered lifecycle; no env/DB/provider. */
import { chromium, firefox, webkit, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const phase = process.argv.includes("--baseline") ? "baseline" : "final";
const run = process.argv.find(argument => argument.startsWith("--run="))?.slice("--run=".length) ?? phase;
if (!/^[a-z0-9-]+$/.test(run)) throw new Error(`Invalid run label: ${run}`);
const browserArgument = process.argv.find(argument => argument.startsWith("--browser="));
const engine = browserArgument?.slice("--browser=".length) ?? "chromium";
if (engine !== "chromium" && engine !== "firefox" && engine !== "webkit") throw new Error(`Unsupported browser: ${engine}`);
const browserType = engine === "firefox" ? firefox : engine === "webkit" ? webkit : chromium;
const output = resolve(browserArgument ? `output/playwright/map-cross-browser/${engine}/dialog/${run}` : "output/playwright/dialog-inert-a11y");
const report = resolve(browserArgument ? "output/p2-map-cross-browser" : "output/p2-dense-map-a11y");
const reportPath = `${report}/${browserArgument ? `${engine}-` : ""}dialog-${run}.json`;
const log: string[] = [];
const cssPaths = ["globals", "preferences", "dialogs"].map(name => `src/app/${name}.css`);
const provenancePaths = ["src/components/dialog.tsx", "scripts/dialog-inert-a11y-browser.ts", ...cssPaths];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function sourceHashes() { return Object.fromEntries(await Promise.all(provenancePaths.map(async path => [path, hash(await readFile(path, "utf8"))]))); }
type Result = { name: string; viewport: string; status: "passed" | "failed"; failureCategory?: "fixture-navigation" | "fixture-initialization" | "behavior"; error?: string; errors: string[]; requests: string[]; evidence: Record<string, unknown> };

async function main() {
  // Explicit engine baselines are evidence: never replace an earlier completed run.
  if (browserArgument && phase === "baseline") {
    const exists = await readFile(reportPath, "utf8").then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
    if (exists) throw new Error(`Immutable baseline already exists: ${reportPath}`);
  }
  await mkdir(output, { recursive: true }); await mkdir(report, { recursive: true });
  const startedAt = new Date().toISOString();
  const sources = await sourceHashes();
  for (const path of provenancePaths) {
    const destination = resolve(output, "preimages", `${path}.txt`);
    await mkdir(resolve(destination, ".."), { recursive: true });
    await writeFile(destination, await readFile(path));
  }
  const bundle = await build({ stdin: { contents: `
    import React,{StrictMode,useEffect,useState} from "react";import {createRoot} from "react-dom/client";
    import {Dialog} from "./src/components/dialog";
    function Fixture(){
      const initial=location.pathname==='/initial-nested';
      const [first,setFirst]=useState(initial),[second,setSecond]=useState(initial),[suspended,setSuspended]=useState(false);
      const [events,setEvents]=useState([]);const nested=location.pathname!='/siblings';
      const closeFirst=()=>{setEvents(old=>[...old,'first']);setFirst(false)};
      const closeSecond=()=>{setEvents(old=>[...old,'second']);setSecond(false)};
      useEffect(()=>{window.fixture={setFirst,setSecond,setSuspended};},[]);
      const child=second&&<Dialog title="Второе окно" onClose={closeSecond}><p>Содержимое второго окна</p><button>Последняя кнопка второго окна</button></Dialog>;
      return <><button id="opener" onClick={()=>setFirst(true)}>Открыть первое окно</button><p>Фоновый текст истории</p>
        <button id="background" onClick={()=>setEvents(old=>[...old,'background'])}>Фоновое действие</button><output id="events">{JSON.stringify(events)}</output>
        <button id="stale-trigger">Другое действие</button><input id="other-focus" aria-label="Другое поле" />
        {first&&<Dialog title="Первое окно" onClose={closeFirst} suspended={suspended}><p>Содержимое первого окна</p>
          <button onClick={()=>setSecond(true)}>Открыть второе окно</button><button>Последняя кнопка первого окна</button>{nested&&child}</Dialog>}
        {!nested&&child}</>;
    }
    createRoot(document.getElementById('root')).render(<StrictMode><Fixture/></StrictMode>);
  `, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"development"' } });
  const css = (await Promise.all(cssPaths.map(path => readFile(path, "utf8")))).join("\n").replace('@import "tailwindcss";', "");
  const html = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><body style="overflow:clip"><main id="root" style="padding:16px"></main><aside id="already-inert" inert="existing-value"><button>Уже недоступно</button></aside><aside id="other-root"><button>Внешнее действие</button></aside><script src="/fixture.js"></script></body></html>';
  const bundledSources = await sourceHashes();
  if (JSON.stringify(sources) !== JSON.stringify(bundledSources)) throw new Error("Sources changed while creating the frozen fixture bundle");
  // Keep the exact served bytes as evidence without linting bundled React/vendor code.
  await Promise.all([writeFile(`${output}/fixture.js.txt`, bundle.outputFiles[0].text), writeFile(`${output}/fixture.css`, css), writeFile(`${output}/fixture.html`, html)]);
  console.log(`BUNDLE_FROZEN ${engine} ${run}`);
  const server = createServer((req, res) => { res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : req.url === "/fixture.css" ? "text/css" : "text/html"); res.end(req.url === "/fixture.js" ? bundle.outputFiles[0].text : req.url === "/fixture.css" ? css : html); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await browserType.launch().catch(async error => { await new Promise<void>(done => server.close(() => done())); throw error; });
  const results: Result[] = [];
  try {
    for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "mobile", width: 390, height: 640 }]) {
      for (const name of ["background-isolation", "late-body-child", "nested-close", "siblings-close", "initial-nested", "suspended-resume", "suspend-without-replacement", "underlying-unmount", "reopen-cleanup", "keyboard-opener", "stale-click-programmatic"]) {
        const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
        page.setDefaultTimeout(2500);
        const result: Result = { name, viewport: viewport.name, status: "passed", errors: [], requests: [], evidence: {} };
        let stage: "fixture-navigation" | "fixture-initialization" | "behavior" = "fixture-navigation";
        page.on("pageerror", error => result.errors.push(error.message));
        await page.addInitScript(() => {
          const clicks: unknown[] = [];
          Object.assign(window, { nativeClickFocusEvidence: clicks });
          document.addEventListener("click", event => {
            const target = event.target instanceof Element ? event.target.closest("button, input, a, [tabindex]") : null;
            const active = document.activeElement;
            clicks.push({ target: target ? { tag: target.tagName, id: target.id, name: target.getAttribute("aria-label") ?? target.textContent?.trim() } : null, activeBeforeHandler: active ? { tag: active.tagName, id: active.id, role: active.getAttribute("role"), name: active.getAttribute("aria-label") } : null, trusted: event.isTrusted });
          }, true);
        });
        await page.route("**/*", route => { const url = new URL(route.request().url()); if (url.origin !== base || url.pathname.startsWith("/api/")) { result.requests.push(`${route.request().method()} ${url.pathname}`); return route.abort(); } return route.continue(); });
        try {
          // Cold Firefox process/page startup is infrastructure; retain short behavior waits.
          await page.goto(`${base}/${name === "initial-nested" ? "initial-nested" : name.startsWith("siblings") || name === "underlying-unmount" || name === "suspended-resume" ? "siblings" : "nested"}`, { timeout: 15000 });
          stage = "fixture-initialization";
          await expect.poll(() => page.evaluate(() => Boolean((window as unknown as FixtureWindow).fixture))).toBe(true);
          stage = "behavior";
          if (name === "keyboard-opener") {
            await page.keyboard.press("Tab");
            await expect(page.locator("#opener")).toBeFocused();
            await page.keyboard.press("Enter");
          } else if (name === "stale-click-programmatic") {
            await page.locator("#stale-trigger").click();
            await page.locator("#other-focus").focus();
            await expect(page.locator("#other-focus")).toBeFocused();
            await setFixture(page, { first: true });
          } else if (name !== "initial-nested") await page.getByRole("button", { name: "Открыть первое окно", exact: true }).click();
          const first = page.getByRole("dialog", { name: "Первое окно", exact: true });
          if (name === "initial-nested") {
            await assertTop(page, "Второе окно", result);
            await page.keyboard.press("Escape");
            await assertTop(page, "Первое окно", result);
            await expect(page.getByRole("dialog")).toHaveCount(1);
            await page.keyboard.press("Escape");
          } else if (name === "background-isolation") {
            await assertTop(page, "Первое окно", result);
            await expect(page.locator("#root")).toHaveAttribute("inert", "");
            await expect(page.locator("#other-root")).toHaveAttribute("inert", "");
            await page.locator("#background").evaluate(element => (element as HTMLElement).focus());
            await expect(first).toBeFocused();
            const bounds = await page.locator("#background").boundingBox();
            expect(bounds).not.toBeNull();
            await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
            expect(await eventLog(page)).not.toContain("background");
            // Backdrop click may close the modal; reopen for keyboard containment if necessary.
            if (!(await first.count())) await page.getByRole("button", { name: "Открыть первое окно", exact: true }).click();
            await page.keyboard.press("Shift+Tab"); await expect(first.getByRole("button", { name: "Последняя кнопка первого окна", exact: true })).toBeFocused();
            await page.keyboard.press("Tab"); await expect(first.getByRole("button", { name: "Закрыть", exact: true })).toBeFocused();
            await page.keyboard.press("Escape");
          } else if (name === "late-body-child") {
            await page.evaluate(() => { const aside = document.createElement("aside"); aside.id = "late"; aside.innerHTML = '<button>Позднее фоновое действие</button>'; document.body.append(aside); });
            await expect(page.locator("#late")).toHaveAttribute("inert", "");
            await assertTop(page, "Первое окно", result);
            expect(await accessibilityTree(page)).not.toContain("Позднее фоновое действие");
            await page.keyboard.press("Escape");
            await expect(page.locator("#late")).not.toHaveAttribute("inert");
          } else if (name === "nested-close" || name === "siblings-close" || name === "underlying-unmount" || name === "suspended-resume") {
            await first.getByRole("button", { name: "Открыть второе окно", exact: true }).click();
            if (name === "suspended-resume") await setFixture(page, { suspended: true });
            await assertTop(page, "Второе окно", result);
            await expect(page.locator(".dialog-backdrop").filter({ has: page.locator('[aria-label="Первое окно"]') })).toHaveAttribute("inert", "");
            if (name === "underlying-unmount") await setFixture(page, { first: false });
            await page.keyboard.press("Escape");
            expect(await eventLog(page)).toEqual(["second"]);
            if (name === "underlying-unmount") await expect(page.getByRole("dialog")).toHaveCount(0);
            else {
              if (name === "suspended-resume") await setFixture(page, { suspended: false });
              await assertTop(page, "Первое окно", result);
              if (name !== "suspended-resume") await expect(first.getByRole("button", { name: "Открыть второе окно", exact: true })).toBeFocused();
              await page.keyboard.press("Escape");
              expect(await eventLog(page)).toEqual(["second", "first"]);
            }
          } else if (name === "suspend-without-replacement") {
            await setFixture(page, { suspended: true });
            await expect(page.getByRole("dialog")).toHaveCount(0);
            await assertRestored(page);
            await setFixture(page, { suspended: false });
            await assertTop(page, "Первое окно", result);
            await page.keyboard.press("Escape");
          } else if (name === "keyboard-opener" || name === "stale-click-programmatic") {
            await assertTop(page, "Первое окно", result);
            await page.keyboard.press("Escape");
          } else {
            for (let iteration = 0; iteration < 3; iteration++) {
              await assertTop(page, "Первое окно", result);
              await page.keyboard.press("Escape"); await assertRestored(page);
              if (iteration < 2) await page.getByRole("button", { name: "Открыть первое окно", exact: true }).click();
            }
          }
          await assertRestored(page);
          if (name === "stale-click-programmatic") await expect(page.locator("#other-focus")).toBeFocused();
          else if (name !== "initial-nested") await expect(page.getByRole("button", { name: "Открыть первое окно", exact: true })).toBeFocused();
          expect(result.errors).toEqual([]); expect(result.requests).toEqual([]);
          result.evidence.finalSnapshot = await accessibilityTree(page);
          result.evidence.events = await eventLog(page);
        } catch (error) { result.status = "failed"; result.failureCategory = stage; result.error = error instanceof Error ? error.message : String(error); }
        result.evidence.nativeInteraction = await page.evaluate(() => ({
          clicks: (window as unknown as { nativeClickFocusEvidence?: unknown[] }).nativeClickFocusEvidence ?? [],
          finalActive: { tag: document.activeElement?.tagName, id: document.activeElement?.id, name: document.activeElement?.getAttribute("aria-label") },
          nativeInertSupported: "inert" in HTMLElement.prototype,
        })).catch(error => ({ unavailable: String(error) }));
        await page.screenshot({ path: `${output}/${phase}-${viewport.name}-${name}.png` }).catch(error => { result.status = "failed"; result.error = String(error); });
        results.push(result); const line = `${result.status.toUpperCase()} ${viewport.name} ${name}${result.error ? `: ${result.error}` : ""}`; log.push(line); console.log(line); await page.close();
      }
    }
  } finally { await browser.close(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
  const endedSources = await sourceHashes();
  const sourceStable = JSON.stringify(sources) === JSON.stringify(endedSources);
  const summary = { total: results.length, passed: results.filter(result => result.status === "passed").length, failed: results.filter(result => result.status === "failed").length };
  const metadata = { generatedAt: new Date().toISOString(), startedAt, engine, browserVersion: browser.version(), executable: browserType.executablePath(), nodeVersion: process.version, platform: process.platform, phase, run, environment: "Actual Dialog; development React StrictMode; ephemeral loopback fixture; no environment/database/providers", accessibilityEvidence: engine === "chromium" ? "Chromium CDP Accessibility.getFullAXTree; native focus/pointer/keyboard assertions" : "Portable DOM semantics excluding hidden/inert subtrees; native focus/pointer/keyboard assertions. Actual platform accessibility tree is unavailable through this engine's Playwright API; DOM semantics are not OS accessibility proof.", provenance: { sources, bundledSources, endedSources, sourceStable, frozenBundleVerified: true, preimages: `${output}/preimages`, preimageSuffix: ".txt", preimagePathMapping: "preimages/<original source path>.txt; sources keys retain original repository paths", persistedBundle: `${output}/fixture.js.txt`, bundleSha256: hash(bundle.outputFiles[0].text), servedCssSha256: hash(css), servedHtmlSha256: hash(html) }, summary, results };
  await writeFile(reportPath, JSON.stringify(metadata, null, 2), browserArgument && phase === "baseline" ? { flag: "wx" } : undefined);
  await writeFile(`${report}/${browserArgument ? `${engine}-` : ""}dialog-${run}.log`, log.join("\n") + "\n");
  console.log(JSON.stringify({ engine, phase, run, ...summary, sourceStable, frozenBundleVerified: true, reportPath }));
  if (results.some(result => result.status === "failed")) process.exitCode = 1;
}

type FixtureWindow = Window & { fixture: { setFirst: (value: boolean) => void; setSecond: (value: boolean) => void; setSuspended: (value: boolean) => void } };
async function setFixture(page: Page, values: { first?: boolean; second?: boolean; suspended?: boolean }) {
  await page.evaluate(values => { const fixture = (window as unknown as FixtureWindow).fixture; if (values.first !== undefined) fixture.setFirst(values.first); if (values.second !== undefined) fixture.setSecond(values.second); if (values.suspended !== undefined) fixture.setSuspended(values.suspended); }, values);
}
async function eventLog(page: Page): Promise<string[]> { return JSON.parse(await page.locator("#events").textContent() ?? "[]"); }
async function assertTop(page: Page, title: string, result: Result) {
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  await expect(dialog).toBeVisible();
  await expect.poll(async () => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  const lastButton = dialog.getByRole("button", { name: title === "Второе окно" ? "Последняя кнопка второго окна" : "Последняя кнопка первого окна", exact: true });
  expect(await lastButton.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    return hit !== null && element.contains(hit);
  })).toBe(true);
  await expect.poll(() => dialog.evaluate(element => {
    const backdrop = element.parentElement!;
    const z = Number.parseInt(getComputedStyle(backdrop).zIndex, 10) || 0;
    return Array.from(document.querySelectorAll<HTMLElement>(".dialog-backdrop:not([hidden])")).every(other => {
      if (other === backdrop) return true;
      const otherZ = Number.parseInt(getComputedStyle(other).zIndex, 10) || 0;
      return otherZ < z || (otherZ === z && Boolean(other.compareDocumentPosition(backdrop) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
  }), { message: "The active dialog must paint above every other visible backdrop" }).toBe(true);
  result.evidence.stack = await page.locator(".dialog-backdrop").evaluateAll(elements => elements.map(element => ({ title: element.querySelector('[role="dialog"]')?.getAttribute("aria-label"), zIndex: getComputedStyle(element).zIndex, hidden: element.hasAttribute("hidden"), inert: element.hasAttribute("inert") })));
  await page.screenshot({ path: `${output}/${phase}-${result.viewport}-${result.name}-${title === "Второе окно" ? "second" : "first"}-open.png`, animations: "disabled" });
  const snapshot = await accessibilityTree(page);
  result.evidence.openSnapshot = snapshot;
  expect(snapshot).not.toContain("Фоновый текст истории"); expect(snapshot).not.toContain("Фоновое действие"); expect(snapshot).not.toContain("Внешнее действие");
  expect(snapshot).not.toContain(title === "Второе окно" ? "Содержимое первого окна" : "Содержимое второго окна");
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
}
async function assertRestored(page: Page) {
  await expect(page.locator("#root")).not.toHaveAttribute("inert");
  await expect(page.locator("#other-root")).not.toHaveAttribute("inert");
  await expect(page.locator("#already-inert")).toHaveAttribute("inert", "existing-value");
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("clip");
  expect(await accessibilityTree(page)).toContain("Фоновый текст истории");
}
async function accessibilityTree(page: Page) {
  if (engine !== "chromium") return page.evaluate(() => {
    // Inspect semantic DOM only, and label it honestly in report metadata.
    // Native focus, pointer and keyboard checks independently enforce inert behavior.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const element = node instanceof Element ? node : node.parentElement;
        if (!element || element.closest('[inert], [hidden], [aria-hidden="true"], script, style')) return NodeFilter.FILTER_REJECT;
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const semantics: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node instanceof Element) {
        const role = node.getAttribute("role"), name = node.getAttribute("aria-label");
        if (role || name) semantics.push(`${role ?? node.tagName.toLowerCase()}: ${name ?? ""}`);
      } else if (node.textContent?.trim()) semantics.push(node.textContent.trim());
    }
    return semantics.join("\n");
  });
  const session = await page.context().newCDPSession(page);
  try {
    const tree = await session.send("Accessibility.getFullAXTree");
    return tree.nodes.filter(node => !node.ignored).map(node => `${node.role?.value ?? ""}: ${node.name?.value ?? ""}`).join("\n");
  } finally { await session.detach(); }
}
main().catch(error => { console.error("Fixture setup failure (not product behavioral RED):", error); process.exitCode = 1; });
