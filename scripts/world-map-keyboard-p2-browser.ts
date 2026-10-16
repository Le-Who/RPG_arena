/** Actual WorldMap/Dialog in isolated browser; no Next server, database, provider or environment files. */
import { chromium, firefox, webkit, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const browserArgument = process.argv.find(argument => argument.startsWith("--browser="))?.slice("--browser=".length);
if (browserArgument && !["chromium", "firefox", "webkit"].includes(browserArgument)) throw new Error("--browser must be chromium, firefox or webkit");
const engine = (browserArgument ?? "chromium") as "chromium" | "firefox" | "webkit";
const stagePreimages = process.argv.includes("--stage-preimages");
if (process.argv.includes("--final") && (stagePreimages || process.argv.includes("--original-preimages"))) throw new Error("Final runs require current production sources; preimage flags are not allowed");
const preimageOutput = resolve("output/p2-map-cross-browser");
const crossBrowser = Boolean(browserArgument) || process.argv.includes("--cross-browser");
const run = process.env.WORLD_MAP_KEYBOARD_RUN ?? (process.argv.includes("--baseline") ? "baseline" : process.argv.includes("--final") ? "final" : "current");
if (!/^[a-z0-9-]+$/i.test(run)) throw new Error("WORLD_MAP_KEYBOARD_RUN must be a simple artifact directory name");
const output = crossBrowser ? resolve("output/playwright/map-cross-browser", engine, "keyboard", run) : resolve("output/playwright/world-map-keyboard-p2");
const reportOutput = resolve(crossBrowser ? "output/p2-map-cross-browser" : "output/p2-map-vitals-coverage");
const reportPath = crossBrowser ? `${reportOutput}/${engine}-keyboard-${run}.json` : `${output}/result.json`;
// Literal geometry and names: independent of projector/mapEdges and of the component's navigation.
const places = [
  ["01", "Локация 01", 0, 0], ["02", "Локация 02", 20, 0], ["03", "Локация 03", 40, 0], ["04", "Локация 04", 60, 0], ["05", "Локация 05", 80, 0], ["06", "Локация 06", 100, 0],
  ["07", "Локация 07", 0, 20], ["08", "Локация 08", 20, 20], ["09", "Локация 09", 40, 20], ["10", "Локация 10", 60, 20], ["11", "Локация 11", 80, 20], ["12", "Локация 12", 100, 20],
  ["13", "Локация 13", 0, 40], ["14", "Локация 14", 20, 40], ["15", "Локация 15", 40, 40], ["16", "Локация 16", 60, 40], ["17", "Локация 17", 80, 40], ["18", "Локация 18", 100, 40],
  ["19", "Локация 19", 0, 60], ["20", "Локация 20", 20, 60], ["21", "Локация 21", 40, 60], ["22", "Локация 22", 60, 60], ["23", "Локация 23", 80, 60], ["24", "Локация 24", 100, 60],
  ["25", "Локация 25", 0, 80], ["26", "Локация 26", 20, 80], ["27", "Локация 27", 40, 80], ["28", "Локация 28", 60, 80], ["29", "Локация 29", 80, 80], ["30", "Локация 30", 100, 80],
  ["31", "Локация 31", 0, 100], ["32", "Локация 32", 20, 100], ["33", "Локация 33", 40, 100], ["34", "Локация 34", 60, 100], ["35", "Локация 35", 80, 100], ["36", "Локация 36", 100, 100],
];
const locations = places.map(([id, name, x, y]) => ({ id, name, x, y, discovered: true, current: id === "01", danger: 24, icon: "📍", connectedTo: id === "01" ? ["02", "hidden", "absent"] : id === "02" ? ["01", "03"] : [] }));
const hidden = { id: "hidden", name: "Скрытый сад", x: 1000, y: 1000, discovered: false, current: false, danger: 90, icon: "🌿", connectedTo: ["01", "36"] };
type Result = { name: string; viewport: string; status: "passed" | "failed"; error?: string; browserErrors: string[]; requests: string[]; focus?: unknown; evidence: Record<string, unknown> };

async function main() {
  await mkdir(output, { recursive: true }); await mkdir(reportOutput, { recursive: true });
  if (run.startsWith("baseline")) {
    try { await readFile(reportPath); throw new Error(`Preserved baseline exists: ${run}; use a new WORLD_MAP_KEYBOARD_RUN`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const sourceHashes = Object.fromEntries(await Promise.all(["src/components/world-map.tsx", "src/components/dialog.tsx", "src/app/globals.css", "src/app/shell.css", "src/app/theatre.css", "src/app/dialogs.css", "scripts/world-map-keyboard-p2-browser.ts"].map(async path => {
    const filename = path.split("/").at(-1)!;
    const source = stagePreimages && ["world-map.tsx", "dialog.tsx", "theatre.css", "dialogs.css"].includes(filename) ? `${preimageOutput}/${filename}.preimage` : path;
    return [path, createHash("sha256").update(await readFile(source)).digest("hex")];
  })));
  const bundle = await build({
    stdin: { contents: `import React from "react"; import {createRoot} from "react-dom/client"; import {WorldMap} from "./src/components/world-map";
      const all=${JSON.stringify(locations)}, hidden=${JSON.stringify(hidden)};
      const mode=location.pathname.slice(1), locations=mode==="empty"?[]:mode==="hidden"?[hidden]:mode==="single"?[all[0],hidden]:[...all,hidden];
      window.mapSelections=[];
      function onLocationClick(name){window.mapSelections.push(name);document.getElementById("selections").textContent=JSON.stringify(window.mapSelections);}
      createRoot(document.getElementById("root")).render(<><button>До карты</button><WorldMap locations={locations} currentLocation="Локация 01" onLocationClick={mode==="readonly"?undefined:onLocationClick}/><button>После карты</button><output id="selections"/></>);`, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"production"' },
    plugins: stagePreimages ? [{ name: "stage-production-preimages", setup(builder) { builder.onLoad({ filter: /[\\/]components[\\/](world-map|dialog)\.tsx$/ }, async args => ({ contents: await readFile(resolve(preimageOutput, `${args.path.split(/[\\/]/).at(-1)}.preimage`), "utf8"), loader: "tsx", resolveDir: resolve("src/components") })); } }] : [],
  });
  const css = (await Promise.all(["globals", "shell", "theatre", "dialogs"].map(name => readFile(stagePreimages && ["theatre", "dialogs"].includes(name) ? `${preimageOutput}/${name}.css.preimage` : `src/app/${name}.css`, "utf8")))).join("\n").replace('@import "tailwindcss";', "");
  const html = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><body><main id="root" style="max-width:420px;padding:16px;margin:auto"></main><script src="/fixture.js"></script></body></html>';
  const server = createServer((req, res) => { res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : req.url === "/fixture.css" ? "text/css" : "text/html"); res.end(req.url === "/fixture.js" ? bundle.outputFiles[0].text : req.url === "/fixture.css" ? css : html); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const results: Result[] = [];
  const browser = await ({ chromium, firefox, webkit }[engine]).launch().catch(async error => { await new Promise<void>(done => server.close(() => done())); throw error; });
  const browserVersion = browser.version();
  try {
    for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "mobile", width: 390, height: 844 }]) {
      for (const name of ["large-enter", "large-space", "escape-close", "button-close", "readonly", "empty", "hidden", "single"]) {
        const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
        page.setDefaultNavigationTimeout(15000);
        const result: Result = { name, viewport: viewport.name, status: "passed", browserErrors: [], requests: [], evidence: {} };
        page.on("pageerror", error => result.browserErrors.push(error.message));
        await page.route("**/*", route => { const url = new URL(route.request().url()); if (url.origin !== base || url.pathname.startsWith("/api/")) { result.requests.push(`${route.request().method()} ${url.pathname}`); return route.abort(); } return route.continue(); });
        try {
          await page.goto(`${base}/${name.startsWith("large") || name.endsWith("close") ? "large" : name}`);
          await page.evaluate(() => document.fonts.ready);

          result.evidence.capabilities = await page.evaluate(() => ({ userAgent: navigator.userAgent, devicePixelRatio, maxTouchPoints: navigator.maxTouchPoints, inert: "inert" in HTMLElement.prototype, fonts: document.fonts.status, reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches }));
          await expect(page.getByRole("button", { name: "До карты", exact: true })).toBeVisible();
          const opener = page.getByRole("button", { name: "Открыть карту крупно", exact: true });
          if (name === "empty" || name === "hidden") {
            await expect(page.getByText("Локации ещё не открыты", { exact: true })).toBeVisible();
            await expect(opener).toHaveCount(0); await expect(page.locator(".gx-map-pin")).toHaveCount(0);
            await expect(page.getByText("Скрытый сад", { exact: true })).toHaveCount(0);
            await page.getByRole("button", { name: "До карты", exact: true }).focus(); await page.keyboard.press("Tab");
            await expect(page.getByRole("button", { name: "После карты", exact: true })).toBeFocused();
          } else {
            const count = name === "single" ? 1 : 36;
            const inline = page.locator("#root .gx-map-canvas");
            await expect(inline.locator(".gx-map-pin")).toHaveCount(count);
            await expect(inline.locator("line")).toHaveCount(name === "single" ? 0 : 2);
            await expect(page.getByText("Скрытый сад", { exact: true })).toHaveCount(0);
            if (name === "readonly") await expect(inline.getByRole("button")).toHaveCount(0);
            await opener.focus(); await page.keyboard.press("Enter");
            const dialog = page.getByRole("dialog", { name: "Карта мира", exact: true });
            await expect(dialog).toBeVisible(); await expect(dialog).toBeFocused();
            await expect(dialog.locator(".gx-map-pin")).toHaveCount(count);
            await expect(dialog.locator("line")).toHaveCount(name === "single" ? 0 : 2);
            await expect(dialog.getByText("Скрытый сад", { exact: true })).toHaveCount(0);
            await expect(dialog.locator(".sr-only")).toContainText(name === "single" ? "Карта: 1 локаций, 0 пройденных маршрутов." : "Карта: 36 локаций, 2 пройденных маршрутов.");
            const close = dialog.getByRole("button", { name: "Закрыть", exact: true });
            await assertViewport(page);
            await page.screenshot({ path: `${output}/${viewport.name}-${name}-open.png`, fullPage: false });
            if (name === "readonly") {
              await expect(dialog.getByRole("button")).toHaveCount(1);
              const region = dialog.getByRole("region", { name: "Карта мира, список локаций", exact: true });
              await page.keyboard.press("Shift+Tab"); await expect(region).toBeFocused();
              await page.keyboard.press("End");
              await expect.poll(() => dialog.locator(".dialog-body").evaluate(node => node.scrollTop)).toBeGreaterThan(0);
              await expect(dialog.locator(".gx-map-pin").last()).toBeInViewport();
              await page.keyboard.press("Shift+Tab"); await expect(close).toBeFocused();
              await page.keyboard.press("Tab"); await expect(region).toBeFocused();
              await page.keyboard.press("Tab"); await expect(close).toBeFocused();
              await page.keyboard.press("Escape");
            } else if (name.startsWith("large")) {
              const last = dialog.getByRole("button", { name: "Отправиться в «Локация 36». Опасность 24 из 100", exact: true });
              await page.keyboard.press("Shift+Tab"); await expect(last).toBeFocused();
              await page.keyboard.press("Tab"); await expect(close).toBeFocused();
              await page.keyboard.press("Shift+Tab"); await expect(last).toBeFocused();
              await page.keyboard.press("Tab"); await expect(close).toBeFocused();
              // Native Tab order must reach every location; the fixture adds no keyboard handlers.
              const reached: string[] = [];
              for (let index = 1; index <= 36; index++) {
                await page.keyboard.press("Tab");
                const label = `Отправиться в «Локация ${String(index).padStart(2, "0")}». Опасность 24 из 100${index === 1 ? ". Вы здесь" : ""}`;
                const pin = dialog.getByRole("button", { name: label, exact: true });
                await expect(pin).toBeFocused(); await expect(pin).toBeInViewport(); reached.push(label);
              }
              result.evidence.reached = reached;
              await page.keyboard.press(name === "large-enter" ? "Enter" : "Space");
              expect(await selections(page)).toEqual(["Локация 36"]);
            } else if (name === "button-close") {
              await page.keyboard.press("Tab"); await expect(close).toBeFocused(); await page.keyboard.press("Enter");
            } else if (name === "single") {
              await page.keyboard.press("Shift+Tab");
              const pin = dialog.getByRole("button", { name: "Отправиться в «Локация 01». Опасность 24 из 100. Вы здесь", exact: true });
              await expect(pin).toBeFocused(); await expect(pin).toBeInViewport();
              await page.keyboard.press("Space"); expect(await selections(page)).toEqual(["Локация 01"]);
            } else await page.keyboard.press("Escape");
            await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
            if (!name.startsWith("large") && name !== "single") expect(await selections(page)).toEqual([]);
            expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
          }
          await assertViewport(page); expect(result.browserErrors).toEqual([]); expect(result.requests).toEqual([]);
          result.evidence.selections = await selections(page);
        } catch (error) { result.status = "failed"; result.error = error instanceof Error ? error.message : String(error); }
        result.focus = await page.evaluate(() => ({ tag: document.activeElement?.tagName, className: (document.activeElement as HTMLElement | null)?.className, role: document.activeElement?.getAttribute("role"), label: document.activeElement?.getAttribute("aria-label"), text: document.activeElement?.textContent?.slice(0, 100) })).catch(() => null);
        await page.screenshot({ path: `${output}/${viewport.name}-${name}.png`, fullPage: false }).catch(error => { result.status = "failed"; result.error = `Screenshot: ${String(error)}`; });
        results.push(result); console.log(`${result.status.toUpperCase()} ${viewport.name} ${name}${result.error ? `: ${result.error}` : ""}`); await page.close();
      }
    }
  } finally { await browser.close(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
  const endedHashes = Object.fromEntries(await Promise.all(["src/components/world-map.tsx", "src/components/dialog.tsx", "src/app/globals.css", "src/app/shell.css", "src/app/theatre.css", "src/app/dialogs.css", "scripts/world-map-keyboard-p2-browser.ts"].map(async path => {
    const filename = path.split("/").at(-1)!;
    const source = stagePreimages && ["world-map.tsx", "dialog.tsx", "theatre.css", "dialogs.css"].includes(filename) ? `${preimageOutput}/${filename}.preimage` : path;
    return [path, createHash("sha256").update(await readFile(source)).digest("hex")];
  })));
  const sourceStable = JSON.stringify(sourceHashes) === JSON.stringify(endedHashes);
  const serialized = JSON.stringify({ generatedAt: new Date().toISOString(), run, engine, browserVersion, crossBrowser, stagePreimages, sourceHashes, endedHashes, sourceStable, bundleSha256: createHash("sha256").update(bundle.outputFiles[0].text).digest("hex"), fixtureCssSha256: createHash("sha256").update(css).digest("hex"), caseCount: results.length, passed: results.filter(result => result.status === "passed").length, failed: results.filter(result => result.status === "failed").length, accessibilityScope: "Portable DOM semantic roles + native keyboard/scroll/focus/activation; no CDP or OS accessibility-tree claim", environment: "production React bundle; actual WorldMap/Dialog; literal synthetic locations; no component/navigation mocks", results }, null, 2);
  await writeFile(`${output}/result.json`, serialized);
  if (crossBrowser) await writeFile(reportPath, serialized, run.startsWith("baseline") ? { flag: "wx" } : undefined);
  else await writeFile(`${output}/original-result.json`, serialized, { flag: "wx" }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  console.log(JSON.stringify({ engine, run, cases: results.length, passed: results.filter(result => result.status === "passed").length, failed: results.filter(result => result.status === "failed").length, report: reportPath }));
  if (results.some(result => result.status === "failed") || (!sourceStable && !run.startsWith("baseline"))) process.exitCode = 1;
}
async function selections(page: Page) { return page.evaluate(() => (window as unknown as { mapSelections: string[] }).mapSelections); }
async function assertViewport(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const dialog = page.getByRole("dialog", { name: "Карта мира", exact: true });
  if (await dialog.count()) {
    expect(await dialog.evaluate(element => { const bounds = element.getBoundingClientRect(); return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth + 1 && bounds.bottom <= innerHeight + 1 && element.scrollWidth <= element.clientWidth + 1; })).toBe(true);
  }
}
main().catch(error => { console.error("Fixture setup failure (not a product behavioral RED):", error); process.exitCode = 1; });
