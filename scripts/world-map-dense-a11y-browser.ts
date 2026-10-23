/** Actual WorldMap/Dialog + production styles. No Next server, DB, providers, or component mocks.
 * Run with --baseline to preserve the failing run separately from subsequent result.json.
 */
import { chromium, firefox, webkit, expect, type Locator, type Page } from "@playwright/test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { launchFixtureBrowser } from "./lib/launch-fixture-browser";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const browserArgument = process.argv.find(argument => argument.startsWith("--browser="))?.slice("--browser=".length);
if (browserArgument && !["chromium", "firefox", "webkit"].includes(browserArgument)) throw new Error("--browser must be chromium, firefox or webkit");
const engine = (browserArgument ?? "chromium") as "chromium" | "firefox" | "webkit";
const crossBrowser = Boolean(browserArgument) || process.argv.includes("--cross-browser");
const originalPreimages = process.argv.includes("--original-preimages");
const stagePreimages = process.argv.includes("--stage-preimages");
const usePreimages = originalPreimages || stagePreimages;
if (process.argv.includes("--final") && usePreimages) throw new Error("Final runs require current production sources; preimage flags are not allowed");
const run = process.env.WORLD_MAP_A11Y_RUN ?? (originalPreimages ? "baseline-corrected" : process.argv.includes("--baseline") ? "baseline" : process.argv.includes("--final") ? "final" : "current");
if (!/^[a-z0-9-]+$/i.test(run)) throw new Error("WORLD_MAP_A11Y_RUN must be a simple artifact directory name");
const output = crossBrowser ? resolve("output/playwright/map-cross-browser", engine, "dense", run) : resolve("output/playwright/world-map-dense-a11y", run);
const reportOutput = resolve(crossBrowser ? "output/p2-map-cross-browser" : "output/p2-dense-map-a11y");
const preimageOutput = resolve(stagePreimages ? "output/p2-map-cross-browser" : "output/p2-dense-map-a11y");
const reportPath = crossBrowser ? `${reportOutput}/${engine}-dense-${run}.json` : `${reportOutput}/${run}-result.json`;
const logPath = crossBrowser ? `${reportOutput}/${engine}-dense-${run}.log` : `${reportOutput}/${run}.log`;
const diagnosticInlineHeight = process.argv.includes("--diagnostic-inline-height60");
const diagnosticFocusScroll = process.argv.includes("--diagnostic-focus-scroll");
if ((diagnosticInlineHeight || diagnosticFocusScroll) && process.argv.includes("--final")) throw new Error("Diagnostic fixture intervention cannot be a final run");
if (diagnosticFocusScroll && !run.includes("diagnostic")) throw new Error("Diagnostic focus repair requires an explicitly diagnostic run name");
if (diagnosticInlineHeight && !run.includes("diagnostic")) throw new Error("Diagnostic fixture CSS requires an explicitly diagnostic run name");
const diagnosticCss = diagnosticInlineHeight ? ".gx-map-canvas:not(.is-large){max-height:min(32rem,60dvh)}" : "";
// Hand-chosen names and coordinates do not call projector, mapEdges, or production navigation.
// Both coincident locations and extreme coordinates are intentional, including the final edges.
const places: [string, number, number][] = [
  ["Площадь встреч у старого городского фонтана", 0, 0],
  ["Мастерская переплётчицы Александры за северными воротами", 0, 0],
  ["Сверхдлинноенеразрывноеназваниелокациибезпробеловдляпроверкипереносатекстанамаленькомэкране", 0, 0],
  ["Тихая библиотека забытых семейных историй", 20, 0], ["Кондитерская у трамвайной остановки", 80, 0], ["Набережная вечерних разговоров", 100, 0],
  ["Сад соседского сообщества", 0, 20], ["Зал настольных игр и дружеских встреч", 20, 20], ["Крытый рынок местных мастеров", 40, 20], ["Музыкальный салон на втором этаже", 60, 20], ["Книжная лавка Марии", 80, 20], ["Двор с цветущей яблоней", 100, 20],
  ["Пекарня с открытой кухней", 0, 40], ["Парк у речного причала", 20, 40], ["Мансарда начинающего художника", 40, 40], ["Кофейня с шахматными столиками", 40, 40], ["Обсерватория на холме", 80, 40], ["Мост между двумя кварталами", 100, 40],
  ["Кинотеатр вечерних премьер", 0, 60], ["Дом общественных собраний", 20, 60], ["Теплица редких растений", 40, 60], ["Летняя веранда возле озера", 60, 60], ["Кружок любителей фотографии", 80, 60], ["Галерея городских воспоминаний", 100, 60],
  ["Репетиционная комната оркестра", 0, 80], ["Туристический центр на площади", 20, 80], ["Лаборатория школьных проектов", 40, 80], ["Почта с коллекцией старых открыток", 60, 80], ["Оранжерея зимнего сада", 80, 80], ["Причал маленьких прогулочных лодок", 100, 80],
  ["Студия танца в бывшем вокзале", 0, 100], ["Часовая башня западного района", 20, 100], ["Музей повседневной городской жизни", 40, 100], ["Дальняя станция пригородного поезда", 60, 100], ["Северо-восточный край лесной тропинки", 100, 100], ["Последняя беседка у юго-западной границы города", -100, -100],
];
const locations = places.map(([name, x, y], index) => ({ id: `dense-${index + 1}`, name, x, y, discovered: true, current: index === 0, danger: index % 3 === 0 ? 84 : index % 3 === 1 ? 24 : 55, icon: "🌿", connectedTo: index === 0 ? ["dense-2", "hidden", "absent"] : index === 1 ? ["dense-1", "dense-3"] : [] }));
const hidden = { id: "hidden", name: "Скрытая локация, которой нет в доступном мире", x: 1000, y: 1000, discovered: false, current: false, danger: 90, icon: "🌿", connectedTo: ["dense-1"] };
const viewports = [{ name: "mobile320", width: 320, height: 740 }, { name: "mobile390", width: 390, height: 844 }, { name: "desktop", width: 1280, height: 900 }];
type Case = { name: string; viewport: typeof viewports[number]; mode?: "readonly" | "sparse"; dialog?: boolean; largeText?: boolean; special?: "keyboard-enter" | "keyboard-space" | "reduced-motion" | "forced-colors" | "text-spacing" };
type Result = { name: string; status: "passed" | "failed"; failures: string[]; evidence: Record<string, unknown>; browserErrors: string[]; unexpectedRequests: string[] };
const cases: Case[] = [
  ...viewports.flatMap(viewport => [
    { name: `${viewport.name}-inline-dense`, viewport },
    { name: `${viewport.name}-dialog-dense`, viewport, dialog: true },
    { name: `${viewport.name}-readonly-semantics`, viewport, mode: "readonly" as const, dialog: true },
  ]),
  { name: "mobile320-keyboard-enter", viewport: viewports[0], dialog: true, special: "keyboard-enter" },
  { name: "desktop-keyboard-space", viewport: viewports[2], dialog: true, special: "keyboard-space" },
  { name: "mobile390-reduced-motion", viewport: viewports[1], special: "reduced-motion" },
  { name: "mobile390-forced-colors", viewport: viewports[1], dialog: true, special: "forced-colors" },
  { name: "mobile320-inline-200pct-text-spacing", viewport: viewports[0], special: "text-spacing" },
  { name: "mobile390-dialog-200pct-text-spacing", viewport: viewports[1], dialog: true, special: "text-spacing" },
  { name: "mobile320-inline-sparse", viewport: viewports[0], mode: "sparse" },
  { name: "desktop-inline-sparse", viewport: viewports[2], mode: "sparse" },
  { name: "mobile390-dialog-sparse", viewport: viewports[1], mode: "sparse", dialog: true },
  { name: "landscape844-inline-keyboard-200pct", viewport: { name: "landscape844", width: 844, height: 390 }, largeText: true, special: "keyboard-enter" },
  { name: "landscape640-dialog-keyboard-200pct", viewport: { name: "landscape640", width: 640, height: 320 }, largeText: true, special: "keyboard-space", dialog: true },
];

async function check(result: Result, name: string, action: () => Promise<unknown>) {
  try { result.evidence[name] = await action() ?? true; }
  catch (error) { result.failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
}

async function geometry(scope: Locator, expected: typeof locations, interactive: boolean) {
  const metrics = await scope.evaluate(canvas => {
    const names = Array.from(canvas.querySelectorAll<HTMLElement>(".gx-map-name")).map(node => {
      const bounds = node.getBoundingClientRect(), box = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, right: bounds.right, bottom: bounds.bottom }, style = getComputedStyle(node), range = document.createRange(); range.selectNodeContents(node);
      const textRects = Array.from(range.getClientRects()).map(r => ({ x: r.x, y: r.y, right: r.right, bottom: r.bottom }));
      const clips: string[] = [];
      let verticalScrollFrame: DOMRect | null = null;
      for (let parent: HTMLElement | null = node; parent && parent !== document.body; parent = parent.parentElement) {
        const s = getComputedStyle(parent), p = parent.getBoundingClientRect();
        // Offscreen content can be recovered inside a scrolling descendant. For an
        // outer hidden frame, measure that scroll viewport, not its offscreen text.
        if (["hidden", "clip"].includes(s.overflowX) && (box.x < p.left - 1 || box.right > p.right + 1)) clips.push(`${parent.className}:horizontal`);
        const visibleTop = verticalScrollFrame?.top ?? box.y, visibleBottom = verticalScrollFrame?.bottom ?? box.bottom;
        if (["hidden", "clip"].includes(s.overflowY) && (visibleTop < p.top - 1 || visibleBottom > p.bottom + 1)) clips.push(`${parent.className}:vertical`);
        if (["auto", "scroll"].includes(s.overflowY) && parent.scrollHeight > parent.clientHeight + 1) verticalScrollFrame = p;
      }
      return { text: node.textContent, visibleText: node.innerText, box, clips, lineClamp: style.webkitLineClamp, overflowX: node.scrollWidth > node.clientWidth + 1, overflowY: node.scrollHeight > node.clientHeight + 1,
        textOutside: textRects.some(r => r.x < box.x - 1 || r.right > box.right + 1 || r.y < box.y - 1 || r.bottom > box.bottom + 1) };
    });
    const overlaps: string[][] = [];
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
      const a = names[i].box, b = names[j].box;
      if (Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1) overlaps.push([names[i].text ?? "", names[j].text ?? ""]);
    }
    const routes = Array.from(canvas.querySelectorAll<HTMLElement>(".gx-map-routes span")).map(node => {
      const box = node.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(node);
      return { text: node.innerText, overflow: node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1, textOutside: Array.from(range.getClientRects()).some(r => r.x < box.x - 1 || r.right > box.right + 1 || r.y < box.y - 1 || r.bottom > box.bottom + 1) };
    });
    return { names, overlaps, routes, pins: Array.from(canvas.querySelectorAll<HTMLElement>(".gx-map-pin")).map(node => { const r = node.getBoundingClientRect(); return { tag: node.tagName, type: node.getAttribute("type"), box: { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom } }; }),
      horizontalPageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      horizontalCanvasOverflow: canvas.scrollWidth > canvas.clientWidth + 1,
      documentHeight: document.documentElement.scrollHeight,
      rootBottom: (document.getElementById("root")?.getBoundingClientRect().bottom ?? 0) + scrollY,
      viewportHeight: innerHeight };
  });
  const problems: string[] = [];
  if (JSON.stringify(metrics.names.map(n => n.text)) !== JSON.stringify(expected.map(loc => loc.name))) problems.push("Not all discovered full names appear exactly once in input order");
  for (const name of metrics.names) {
    if (name.text !== name.visibleText || name.overflowX || name.overflowY || name.textOutside || name.clips.length || (name.lineClamp !== "none" && name.lineClamp !== "0")) problems.push(`Clipped/clamped name ${name.text}: ${JSON.stringify(name)}`);
  }
  if (metrics.overlaps.length) problems.push(`Overlapping names (${metrics.overlaps.length}): ${JSON.stringify(metrics.overlaps.slice(0, 8))}`);
  for (const route of metrics.routes) if (route.overflow || route.textOutside) problems.push(`Clipped visible route: ${JSON.stringify(route)}`);
  if (metrics.pins.length !== expected.length) problems.push(`Expected ${expected.length} pins, found ${metrics.pins.length}`);
  if (interactive) for (const pin of metrics.pins) if (pin.tag !== "BUTTON" || pin.type !== "button" || pin.box.width < 44 || pin.box.height < 44) problems.push(`Invalid native touch target: ${JSON.stringify(pin)}`);
  if (metrics.horizontalPageOverflow || metrics.horizontalCanvasOverflow) problems.push("Horizontal page/canvas overflow");
  if (metrics.documentHeight > Math.max(metrics.viewportHeight, metrics.rootBottom) + 1) problems.push(`Ghost document scroll: ${metrics.documentHeight}px exceeds viewport/root bottom ${Math.max(metrics.viewportHeight, metrics.rootBottom)}px`);
  expect(problems, JSON.stringify({ problems, metrics }, null, 2)).toEqual([]);
  return metrics;
}

async function semantics(page: Page, scope: Locator, expected: typeof locations, readonly: boolean, modal: boolean) {
  const snapshot = await (modal ? page.locator("body") : scope).ariaSnapshot();
  // ariaSnapshot is a DOM-based semantic view and can include inert DOM. Only
  // Chromium exposes CDP unignored AX nodes; all engines also prove native isolation.
  let accessibleNodes: { role: unknown; name: unknown }[] = [];
  if (engine === "chromium") {
    const session = await page.context().newCDPSession(page);
    accessibleNodes = (await session.send("Accessibility.getFullAXTree")).nodes.filter(node => !node.ignored).map(node => ({ role: node.role?.value, name: node.name?.value }));
    await session.detach();
  }
  const accessibleNames = accessibleNodes.map(node => String(node.name ?? "")).join("\n");
  const failures: string[] = [];
  for (const location of expected) if (!snapshot.includes(location.name)) failures.push(`Accessible name absent: ${location.name}`);
  if (snapshot.includes(hidden.name)) failures.push("Undiscovered location exposed in DOM semantic snapshot");
  if (accessibleNames.includes(hidden.name)) failures.push("Undiscovered location exposed in Chromium AX tree");
  for (const location of expected) if (engine === "chromium" && !accessibleNames.includes(location.name)) failures.push(`Name absent in Chromium AX tree: ${location.name}`);
  if (await scope.getByRole("list").count() !== 1 || await scope.getByRole("listitem").count() !== expected.length) failures.push("Locations are not represented as one semantic list of listitems");
  // Two known reciprocal/adjacent routes, independently hand-derived from fixture.
  const expectedRoutes = expected.length === 3 ? [] : [
    "Площадь встреч у старого городского фонтана — Мастерская переплётчицы Александры за северными воротами",
    "Мастерская переплётчицы Александры за северными воротами — Сверхдлинноенеразрывноеназваниелокациибезпробеловдляпроверкипереносатекстанамаленькомэкране",
  ];
  const visibleRoutes = await scope.locator(".gx-map-routes span").allInnerTexts();
  if (JSON.stringify(visibleRoutes) !== JSON.stringify(expectedRoutes)) failures.push(`Visible routes mismatch: ${JSON.stringify(visibleRoutes)}`);
  const pins = scope.locator(".gx-map-pin");
  if (await scope.locator('[aria-current="location"]').count() !== 1) failures.push("Current location lacks unique aria-current=location");
  const hiddenDecorations = await scope.evaluate(canvas => Array.from(canvas.querySelectorAll("svg, .gx-map-dot")).every(node => Boolean(node.closest('[aria-hidden="true"]'))));
  if (!hiddenDecorations) failures.push("Decorative SVG/emoji exposed to accessibility tree");
  if (readonly) {
    if (await scope.locator('button, a[href], [tabindex="0"]').count()) failures.push("Readonly map contains inert interactive controls");
    for (let index = 0; index < expected.length; index++) {
      const text = await pins.nth(index).innerText();
      if (!text.includes(`Опасность ${expected[index].danger} из 100`)) failures.push(`Readonly danger is not descriptive: ${expected[index].name}`);
      if (index === 0 && !text.includes("Вы здесь")) failures.push("Readonly current location lacks visible description");
    }
  } else {
    if (await scope.getByRole("button").count() !== expected.length) failures.push("Graph creates duplicate location controls or location controls absent");
    for (const location of expected) if (await scope.getByRole("button", { name: label(location), exact: true }).count() !== 1) failures.push(`Button lacks travel/danger/current accessible name: ${location.name}`);
  }
  if (modal) {
    if (accessibleNames.includes("До карты") || accessibleNames.includes("После карты") || accessibleNames.includes("Открыть карту крупно")) failures.push("Background controls remain in modal Chromium accessibility tree");
    if (!await page.locator("#root").evaluate(node => Boolean(node.closest("[inert]")))) failures.push("Dialog background root is not inert");
  }
  expect(failures, JSON.stringify({ failures, snapshot, accessibleNodes }, null, 2)).toEqual([]);
  let nativeModalIsolation: unknown = null;
  if (modal) {
    const before = page.getByRole("button", { name: "До карты", exact: true, includeHidden: true });
    const active = await page.evaluateHandle(() => document.activeElement);
    await before.evaluate(node => (node as HTMLElement).focus());
    await expect(page.getByRole("dialog")).toBeFocused();
    // The backdrop must intercept native pointer hit testing; trial never invokes a handler.
    let backgroundPointerBlocked = false;
    try { await before.click({ trial: true, timeout: 300 }); } catch (error) {
      if (!(error instanceof Error) || !/timeout/i.test(error.message)) throw error;
      backgroundPointerBlocked = true;
    }
    expect(backgroundPointerBlocked).toBe(true);
    await active.evaluate(node => (node as HTMLElement | null)?.focus());
    await active.dispose();
    nativeModalIsolation = { programmaticBackgroundFocusBlocked: true, backgroundPointerBlocked };
  }
  return { semanticSnapshot: snapshot, accessibleNodes, nativeModalIsolation,
    accessibilityScope: engine === "chromium" ? "DOM semantics + Chromium CDP unignored AX tree + native inert/focus/pointer" : "DOM semantics + native inert/focus/pointer; no CDP/OS accessibility-tree claim" };
}
function label(location: typeof locations[number]) { return `Отправиться в «${location.name}». Опасность ${location.danger} из 100${location.current ? ". Вы здесь" : ""}`; }

async function focusedFullyVisible(pin: Locator, allowOversized = false) {
  await expect(pin).toBeFocused({ timeout: 250 });
  let geometry: unknown;
  // Native focus and scrolling can settle in separate rendering frames (WebKit).
  // Poll the original visibility invariant; no fixture scrolling or focus repair.
  await expect(async () => { geometry = await inspectFocusedFullyVisible(pin, allowOversized); }).toPass({ timeout: 1500, intervals: [16, 32, 64, 128] });
  return geometry;
}
async function inspectFocusedFullyVisible(pin: Locator, allowOversized = false) {
  const geometry = await pin.evaluate(node => {
    const box = node.getBoundingClientRect();
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
    const rootStyle = getComputedStyle(document.documentElement), buttonStyle = getComputedStyle(node);
    // Root scroll padding reserves space for the app's sticky shell. It applies
    // to native page scrolling, while a locked page uses the modal scrollport.
    let usableTop = document.body.style.overflow === "hidden" ? 0 : parseFloat(rootStyle.scrollPaddingTop) || 0;
    let usableBottom = innerHeight - (document.body.style.overflow === "hidden" ? 0 : parseFloat(rootStyle.scrollPaddingBottom) || 0);
    const ancestors: { className: string; overflow: string; top: number; bottom: number }[] = [];
    // Body overflow propagates to the viewport; its content-height rectangle does
    // not clip a fixed portal. The explicit viewport bounds above cover that root.
    for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) {
        const p = parent.getBoundingClientRect(); left = Math.max(left, p.left); right = Math.min(right, p.right); top = Math.max(top, p.top); bottom = Math.min(bottom, p.bottom);
        usableTop = Math.max(usableTop, p.top + (parseFloat(style.scrollPaddingTop) || 0));
        usableBottom = Math.min(usableBottom, p.bottom - (parseFloat(style.scrollPaddingBottom) || 0));
        ancestors.push({ className: parent.className, overflow: `${style.overflowX} ${style.overflowY}`, top: p.top, bottom: p.bottom });
      }
    }
    const name = node.querySelector<HTMLElement>(".gx-map-name"), nameBox = name?.getBoundingClientRect();
    const scrollParent = Array.from((function* () { for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) yield parent; })()).find(parent => ["auto", "scroll"].includes(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight + 1);
    const frame = scrollParent?.getBoundingClientRect();
    const textReachable = !nameBox || !frame || (nameBox.top - frame.top + scrollParent!.scrollTop >= -1 && nameBox.bottom - frame.top + scrollParent!.scrollTop <= scrollParent!.scrollHeight + 1);
    const usableHeight = Math.max(0, usableBottom - usableTop - (parseFloat(buttonStyle.scrollMarginTop) || 0) - (parseFloat(buttonStyle.scrollMarginBottom) || 0));
    return { fullyVisible: box.left >= left - 1 && box.right <= right + 1 && box.top >= top - 1 && box.bottom <= bottom + 1,
      oversized: box.height > usableHeight + 1, usableHeight, visibleHeight: Math.max(0, Math.min(box.bottom, bottom) - Math.max(box.top, top)),
      visibleTextHeight: nameBox ? Math.max(0, Math.min(nameBox.bottom, bottom) - Math.max(nameBox.top, top)) : 0,
      horizontalVisible: box.left >= left - 1 && box.right <= right + 1, textReachable,
      box: { x: box.x, y: box.y, width: box.width, height: box.height }, clip: { left, top, right, bottom }, ancestors };
  });
  if (allowOversized && geometry.oversized) {
    expect(geometry.visibleHeight, JSON.stringify(geometry)).toBeGreaterThan(0);
    expect(geometry.visibleTextHeight, JSON.stringify(geometry)).toBeGreaterThan(0);
    expect(geometry.horizontalVisible, JSON.stringify(geometry)).toBe(true);
    expect(geometry.textReachable, JSON.stringify(geometry)).toBe(true);
  } else expect(geometry.fullyVisible, JSON.stringify(geometry)).toBe(true);
  return geometry;
}

async function keyboard(page: Page, scope: Locator, key: "Enter" | "Space", modal: boolean, allowOversized: boolean) {
  const dialog = page.getByRole("dialog", { name: "Карта мира", exact: true });
  const close = dialog.getByRole("button", { name: "Закрыть", exact: true });
  const failures: string[] = [], reached: string[] = [], focusGeometry: unknown[] = [];
  if (modal) { await page.keyboard.press("Tab"); await expect(close).toBeFocused(); }
  else await page.getByRole("button", { name: "До карты", exact: true }).focus();
  for (const location of locations) {
    await page.keyboard.press("Tab");
    const pin = scope.getByRole("button", { name: label(location), exact: true });
    try { focusGeometry.push(await focusedFullyVisible(pin, allowOversized)); reached.push(location.name); } catch (error) { failures.push(`Forward ${location.name}: ${String(error)}`); }
  }
  await page.keyboard.press("Tab"); await expect(modal ? close : page.getByRole("button", { name: "Открыть карту крупно", exact: true })).toBeFocused();
  for (const location of [...locations].reverse()) {
    await page.keyboard.press("Shift+Tab");
    try { focusGeometry.push(await focusedFullyVisible(scope.getByRole("button", { name: label(location), exact: true }), allowOversized)); } catch (error) { failures.push(`Reverse ${location.name}: ${String(error)}`); }
  }
  await page.keyboard.press(key);
  if (modal) {
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Открыть карту крупно", exact: true })).toBeFocused();
  }
  expect(await page.evaluate(() => (window as unknown as { mapSelections: string[] }).mapSelections)).toEqual([locations[0].name]);
  expect(failures, JSON.stringify({ failures, reached }, null, 2)).toEqual([]);
  return { reached, forward: 36, reverse: 36, activation: key, selectedExactlyOnce: locations[0].name, focusGeometry };
}

async function readonlyKeyboard(page: Page, scope: Locator) {
  const dialog = page.getByRole("dialog", { name: "Карта мира", exact: true });
  const close = dialog.getByRole("button", { name: "Закрыть", exact: true });
  const region = dialog.getByRole("region", { name: "Карта мира, список локаций", exact: true });
  await expect(region).toHaveCount(1, { timeout: 1500 });
  await expect(region).toHaveAttribute("tabindex", "0");
  await close.focus(); await page.keyboard.press("Tab"); await expect(region).toBeFocused();
  // The expanded map remains natural flow; a focusable map region gives native
  // keyboard scrolling access to its containing dialog body without fake actions.
  const frame = await region.evaluateHandle(node => {
    for (let parent: HTMLElement | null = node as HTMLElement; parent && parent !== document.body; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (["auto", "scroll"].includes(style.overflowY) && parent.scrollHeight > parent.clientHeight + 1) return parent;
    }
    return null;
  });
  const before = await frame.evaluate(node => (node as HTMLElement | null)?.scrollTop ?? -1);
  expect(before).toBeGreaterThanOrEqual(0);
  await page.keyboard.press("PageDown");
  await expect.poll(() => frame.evaluate(node => (node as HTMLElement).scrollTop), { timeout: 1500 }).toBeGreaterThan(before + 1);
  const afterPageDown = await frame.evaluate(node => (node as HTMLElement).scrollTop);
  await page.keyboard.press("End");
  await expect.poll(() => frame.evaluate(node => Math.abs((node as HTMLElement).scrollTop + (node as HTMLElement).clientHeight - (node as HTMLElement).scrollHeight)), { timeout: 1500 }).toBeLessThanOrEqual(2);
  const afterEnd = await frame.evaluate(node => ({ top: (node as HTMLElement).scrollTop, height: (node as HTMLElement).clientHeight, fullHeight: (node as HTMLElement).scrollHeight }));
  const last = scope.locator(".gx-map-pin").last();
  const visibleLast = await last.evaluate(node => {
    const r = node.getBoundingClientRect(), frame = node.closest(".dialog-body")!.getBoundingClientRect();
    return { fullEntryVisible: r.top >= Math.max(0, frame.top) - 1 && r.bottom <= Math.min(innerHeight, frame.bottom) + 1, fullName: node.querySelector(".gx-map-name")?.textContent, text: (node as HTMLElement).innerText };
  });
  expect(visibleLast.fullEntryVisible, JSON.stringify(visibleLast)).toBe(true);
  expect(visibleLast.fullName).toBe(locations[35].name);
  await page.keyboard.press("Shift+Tab"); await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab"); await expect(region).toBeFocused();
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Открыть карту крупно", exact: true })).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { mapSelections: string[] }).mapSelections)).toEqual([]);
  await frame.dispose();
  return { nativeKeys: ["Tab", "PageDown", "End", "Shift+Tab", "Shift+Tab", "Escape"], before, afterPageDown, afterEnd, visibleLast };
}

async function pointerSelections(page: Page, scope: Locator, touch: boolean) {
  expect(await page.evaluate(() => (window as unknown as { mapSelections: string[] }).mapSelections)).toEqual([]);
  for (const location of locations) {
    const pin = scope.getByRole("button", { name: label(location), exact: true });
    // Locator tap/click performs native scrolling and hit testing: overlapping or
    // obscured controls cannot satisfy this by calling the React handler directly.
    if (touch) await pin.tap(); else await pin.click();
  }
  const selections = await page.evaluate(() => (window as unknown as { mapSelections: string[] }).mapSelections);
  expect(selections).toEqual(locations.map(location => location.name));
  const pointerEvents = await page.evaluate(() => (window as unknown as { mapPointerEvents: { pointerType: string; isTrusted: boolean }[] }).mapPointerEvents);
  expect(pointerEvents).toHaveLength(locations.length);
  expect(pointerEvents.every(event => event.isTrusted && event.pointerType === (touch ? "touch" : "mouse"))).toBe(true);
  return { input: touch ? "touch-tap" : "mouse-click", selections, count: selections.length, pointerEvents };
}

async function main() {
  expect(cases.length).toBeLessThanOrEqual(20);
  await mkdir(output, { recursive: true }); await mkdir(reportOutput, { recursive: true });
  if (run.startsWith("baseline")) {
    try { await readFile(reportPath); throw new Error(`Preserved baseline exists: ${run}; use a new WORLD_MAP_A11Y_RUN`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const sourceHashes = Object.fromEntries(await Promise.all(["src/components/world-map.tsx", "src/components/dialog.tsx", "src/app/globals.css", "src/app/shell.css", "src/app/theatre.css", "src/app/dialogs.css", "scripts/world-map-dense-a11y-browser.ts"].map(async path => {
    const filename = path.split("/").at(-1)!;
    const source = usePreimages && ["world-map.tsx", "dialog.tsx", "theatre.css", "dialogs.css"].includes(filename) ? `${preimageOutput}/${filename}.preimage` : path;
    return [path, createHash("sha256").update(await readFile(source)).digest("hex")];
  })));
  const bundle = await build({ stdin: { contents: `import React from "react";import {createRoot} from "react-dom/client";import {WorldMap} from "./src/components/world-map";
    const all=${JSON.stringify(locations)},hidden=${JSON.stringify(hidden)};const mode=location.pathname.slice(1),locations=mode==="sparse"?[all[0],all[2],all[35],hidden]:[...all,hidden];window.mapSelections=[];window.mapPointerEvents=[];document.addEventListener("pointerdown",event=>window.mapPointerEvents.push({pointerType:event.pointerType,isTrusted:event.isTrusted}));
    function select(name){window.mapSelections.push(name)}
    createRoot(document.getElementById("root")).render(<><button>До карты</button><WorldMap locations={locations} currentLocation={all[0].name} onLocationClick={mode==="readonly"?undefined:select}/><button>После карты</button></>);`, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"production"' },
    plugins: usePreimages ? [{ name: "original-production-preimages", setup(builder) { builder.onLoad({ filter: /[\\/]components[\\/](world-map|dialog)\.tsx$/ }, async args => ({ contents: await readFile(resolve(preimageOutput, `${args.path.split(/[\\/]/).at(-1)}.preimage`), "utf8"), loader: "tsx", resolveDir: resolve("src/components") })); } }] : [],
  });
  const css = (await Promise.all(["globals", "shell", "theatre", "dialogs"].map(name => readFile(usePreimages && ["theatre", "dialogs"].includes(name) ? `${preimageOutput}/${name}.css.preimage` : `src/app/${name}.css`, "utf8")))).join("\n").replace('@import "tailwindcss";', "") + diagnosticCss;
  const html = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><body><main id="root" style="max-width:420px;padding:16px;margin:auto"></main><script src="/fixture.js"></script></body></html>';
  const server = createServer((req, res) => { res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : req.url === "/fixture.css" ? "text/css" : "text/html"); res.end(req.url === "/fixture.js" ? bundle.outputFiles[0].text : req.url === "/fixture.css" ? css : html); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const results: Result[] = [], browser = await launchFixtureBrowser(server, () => ({ chromium, firefox, webkit }[engine]).launch());
  const browserVersion = browser.version();
  try {
    for (const testCase of cases) {
      const result: Result = { name: testCase.name, status: "passed", failures: [], evidence: {}, browserErrors: [], unexpectedRequests: [] };
      const touch = testCase.viewport.name.startsWith("mobile");
      const page = await browser.newPage({ viewport: testCase.viewport, hasTouch: touch, reducedMotion: "reduce", forcedColors: testCase.special === "forced-colors" ? "active" : "none" });
      if (diagnosticFocusScroll) await page.addInitScript(() => {
        document.addEventListener("focusin", event => {
          const target = event.target;
          if (!(target instanceof HTMLButtonElement) || !target.matches("button.gx-map-pin:focus-visible")) return;
          requestAnimationFrame(() => {
            if (document.activeElement === target) target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
          });
        });
      });
      page.setDefaultTimeout(1500);
      page.setDefaultNavigationTimeout(15000);
      page.on("pageerror", error => result.browserErrors.push(error.message));
      await page.route("**/*", route => { const url = new URL(route.request().url()); if (url.origin !== base || url.pathname.startsWith("/api/")) { result.unexpectedRequests.push(`${route.request().method()} ${url.pathname}`); return route.abort(); } return route.continue(); });
      try {
        await page.goto(`${base}/${testCase.mode ?? "dense"}`);
        await page.evaluate(() => document.fonts.ready);
        result.evidence.capabilities = await page.evaluate(() => ({ userAgent: navigator.userAgent, devicePixelRatio, maxTouchPoints: navigator.maxTouchPoints, inert: "inert" in HTMLElement.prototype, forcedColors: matchMedia("(forced-colors: active)").matches, reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches, fonts: document.fonts.status, rootFont: getComputedStyle(document.documentElement).fontSize }));
        await expect(page.getByRole("button", { name: "До карты", exact: true })).toBeVisible();
        const initialTextSettings = await page.evaluate(() => ({ rootFontSize: parseFloat(getComputedStyle(document.documentElement).fontSize), nameFontSize: parseFloat(getComputedStyle(document.querySelector(".gx-map-name")!).fontSize) }));
        if (testCase.special === "text-spacing" || testCase.largeText) {
          await page.addStyleTag({ content: "html{font-size:200%!important}*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}" });
          // Browsers may flush root and rem-dependent descendant styles in separate frames.
          // Require real label enlargement before any screenshot or layout evidence.
          await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize)), { timeout: 1500 }).toBeGreaterThanOrEqual(initialTextSettings.rootFontSize * 2);
          await expect.poll(() => page.evaluate(() => {
            const name = document.querySelector<HTMLElement>(".gx-map-name")!;
            // Reading layout also resolves rem-dependent custom properties in WebKit.
            document.documentElement.getBoundingClientRect(); name.getBoundingClientRect();
            return parseFloat(getComputedStyle(name).fontSize);
          }), { timeout: 1500 }).toBeGreaterThanOrEqual(initialTextSettings.nameFontSize * 2);
        }
        const textSettings = await page.evaluate(() => { const root = getComputedStyle(document.documentElement); const name = getComputedStyle(document.querySelector(".gx-map-name")!); return { rootFontSize: parseFloat(root.fontSize), nameFontSize: name.fontSize, lineHeight: name.lineHeight, letterSpacing: name.letterSpacing, wordSpacing: name.wordSpacing }; });
        result.evidence.textSettings = { initialRootFontSize: initialTextSettings.rootFontSize, initialNameFontSize: initialTextSettings.nameFontSize, ...textSettings, enlarged: Boolean(testCase.special === "text-spacing" || testCase.largeText) };
        if (testCase.special === "text-spacing" || testCase.largeText) {
          expect(textSettings.rootFontSize).toBeGreaterThanOrEqual(initialTextSettings.rootFontSize * 2);
          expect(parseFloat(textSettings.nameFontSize)).toBeGreaterThanOrEqual(initialTextSettings.nameFontSize * 2);
        }
        const expected = testCase.mode === "sparse" ? [locations[0], locations[2], locations[35]] : locations;
        if (testCase.dialog) {
          await page.getByRole("button", { name: "Открыть карту крупно", exact: true }).focus(); await page.keyboard.press("Enter");
          await expect(page.getByRole("dialog", { name: "Карта мира", exact: true })).toBeFocused();
        }
        const scope = testCase.dialog ? page.getByRole("dialog", { name: "Карта мира", exact: true }).locator(".gx-map-canvas") : page.locator("#root .gx-map-canvas");
        // Capture actual full-page baseline before assertions or activation change the page.
        await page.screenshot({ path: `${output}/${testCase.name}-full.png`, fullPage: true, timeout: 15000 });
        const snapshot = await page.locator("body").ariaSnapshot();
        await writeFile(`${output}/${testCase.name}-aria.yml`, snapshot);
        result.evidence.initialAccessibilitySnapshot = snapshot;
        await check(result, "geometry", () => geometry(scope, expected, testCase.mode !== "readonly"));
        await check(result, "semantics", () => semantics(page, scope, expected, testCase.mode === "readonly", Boolean(testCase.dialog)));
        if (testCase.mode === "readonly") await check(result, "readonly-keyboard-scroll", () => readonlyKeyboard(page, scope));
        if (testCase.name.endsWith("-inline-dense")) await check(result, "pointer-selections", () => pointerSelections(page, scope, touch));
        if (testCase.special?.startsWith("keyboard")) await check(result, "keyboard", () => keyboard(page, scope, testCase.special === "keyboard-enter" ? "Enter" : "Space", Boolean(testCase.dialog), Boolean(testCase.largeText)));
        if (testCase.special === "reduced-motion") await check(result, "reduced-motion", async () => {
          const motion = await scope.evaluate(canvas => Array.from(canvas.querySelectorAll("*" )).flatMap(node => { const s = getComputedStyle(node); return [...s.transitionDuration.split(","), ...s.animationDuration.split(",")].map(duration => ({ node: node.className, seconds: parseFloat(duration) * (duration.trim().endsWith("ms") ? .001 : 1) })); }).filter(value => value.seconds > .01));
          expect(motion, "Reduced-motion map must remove movement transitions/animations").toEqual([]); return motion;
        });
        if (testCase.special === "forced-colors") await check(result, "forced-colors-focus", async () => {
          await page.keyboard.press("Tab"); await page.keyboard.press("Tab"); const pin = scope.locator(".gx-map-pin").first(); await expect(pin).toBeFocused();
          const outline = await pin.evaluate(node => { const s = getComputedStyle(node); return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), color: s.outlineColor, forced: matchMedia("(forced-colors: active)").matches }; });
          expect(outline.forced).toBe(true); expect(outline.style).not.toBe("none"); expect(outline.width).toBeGreaterThanOrEqual(2);
          await page.screenshot({ path: `${output}/${testCase.name}-focus.png`, fullPage: false, timeout: 15000 }); return outline;
        });
        if (testCase.dialog && await page.getByRole("dialog").count()) await check(result, "modal-bounds", async () => {
          const bounds = await page.getByRole("dialog").evaluate(node => { const r = node.getBoundingClientRect(); return { fits: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1, noHorizontalOverflow: node.scrollWidth <= node.clientWidth + 1 }; });
          expect(bounds).toEqual({ fits: true, noHorizontalOverflow: true }); return bounds;
        });
      } catch (error) { result.failures.push(`Case setup/interaction: ${error instanceof Error ? error.message : String(error)}`); }
      if (result.browserErrors.length) result.failures.push(`Browser errors: ${JSON.stringify(result.browserErrors)}`);
      if (result.unexpectedRequests.length) result.failures.push(`External/API requests: ${JSON.stringify(result.unexpectedRequests)}`);
      result.status = result.failures.length ? "failed" : "passed";
      results.push(result); console.log(`${result.status.toUpperCase()} ${result.name}${result.failures.length ? ` (${result.failures.length} checks)` : ""}`);
      await page.close();
    }
  } finally { await browser.close(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
  const endedHashes = Object.fromEntries(await Promise.all(["src/components/world-map.tsx", "src/components/dialog.tsx", "src/app/globals.css", "src/app/shell.css", "src/app/theatre.css", "src/app/dialogs.css", "scripts/world-map-dense-a11y-browser.ts"].map(async path => {
    const filename = path.split("/").at(-1)!;
    const source = usePreimages && ["world-map.tsx", "dialog.tsx", "theatre.css", "dialogs.css"].includes(filename) ? `${preimageOutput}/${filename}.preimage` : path;
    return [path, createHash("sha256").update(await readFile(source)).digest("hex")];
  })));
  const sourceStable = JSON.stringify(sourceHashes) === JSON.stringify(endedHashes);
  const report = { generatedAt: new Date().toISOString(), run, engine, browserVersion, crossBrowser, originalPreimages, stagePreimages, diagnosticCss, diagnosticFocusScroll, sourceHashes, endedHashes, sourceStable, bundleSha256: createHash("sha256").update(bundle.outputFiles[0].text).digest("hex"), fixtureCssSha256: createHash("sha256").update(css).digest("hex"), accessibilityScope: engine === "chromium" ? "Chromium CDP AX + portable DOM/native behavior" : "Portable DOM/native behavior; CDP/OS AX unavailable and not claimed", environment: "production React bundle; actual WorldMap/Dialog + production CSS; literal synthetic locations; local assets only; no Next/env/DB/provider", caseCount: results.length, passed: results.filter(result => result.status === "passed").length, failed: results.filter(result => result.status === "failed").length, results };
  const serialized = JSON.stringify(report, null, 2);
  await writeFile(`${output}/result.json`, serialized);
  await writeFile(reportPath, serialized, run.startsWith("baseline") ? { flag: "wx" } : undefined);
  await writeFile(logPath, results.map(result => `${result.status.toUpperCase()} ${result.name}\n${result.failures.join("\n")}`).join("\n\n"), run.startsWith("baseline") ? { flag: "wx" } : undefined);
  console.log(JSON.stringify({ run, cases: report.caseCount, passed: report.passed, failed: report.failed, engine, report: reportPath }));
  if (report.failed || (!sourceStable && !run.startsWith("baseline"))) process.exitCode = 1;
}
main().catch(error => { console.error("Fixture setup failure (not product behavioral RED):", error); process.exitCode = 1; });
