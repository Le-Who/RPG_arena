/** Actual reporter/React lifecycle; controlled Next callback and optional observer inputs; loopback HTTP only. */
import { chromium, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type Entry = { name: string; duration: number; startTime: number };
type Vital = { id: string; name: string; value: number; navigationType?: string };
type Sample = { metric: string; value: number; route: string; device: string; navigationType: string };
type FetchCall = { method: string; keepalive: boolean; credentials: string; body: string; cause: string };
type State = { observers: { type: string; disconnected: boolean }[]; listeners: { pagehide: number; visibilitychange: number }; registrations: number; uniqueCallbacks: number; fetchCalls: FetchCall[] };
type Fixture = {
  mount(): void; unmount(): void; render(): void; privacy(dnt: string | null, gpc: boolean): void;
  vital(value: Vital): void; entries(type: "resource" | "measure", entries: Entry[]): void;
  event(type: "pagehide" | "hidden" | "visible"): void; state(): State;
  restoreEntries(): void; nativeMeasure(name: string, start: number, duration: number): Promise<void>;
};
declare global { interface Window { vitalsFixture: Fixture } }
type Capture = { method: string; path: string; contentType: string | undefined; body: { samples: Sample[] } };
type Result = { name: string; status: "passed" | "failed"; error?: string; requests: Capture[]; fetchCalls: FetchCall[]; browserErrors: string[]; blocked: string[]; evidence: Record<string, unknown> };
const output = resolve("output/playwright/web-vitals-lifecycle-p2");
const reportOutput = resolve("output/p2-map-vitals-coverage");
const tag = process.env.VITALS_RUN_TAG ?? "current";
const caseFilter = process.env.VITALS_CASE_FILTER ?? "";
if (!/^[a-z0-9-]+$/.test(tag)) throw new Error("VITALS_RUN_TAG must be a simple artifact label");
const measure = (startTime = 1, duration = 17): Entry => ({ name: "chronicle:turn:first-text", duration, startTime });
const vital = (id = "synthetic-metric-id", value = 123): Vital => ({ id, name: "LCP", value, navigationType: "navigate" });
const sample = (metric = "LCP", value = 123, route = "/play/[id]", device = "desktop", navigationType = "navigate"): Sample => ({ metric, value, route, device, navigationType });

async function main() {
  await mkdir(output, { recursive: true }); await mkdir(reportOutput, { recursive: true });
  await writeFile(`${reportOutput}/web-vitals.tsx.preimage`, await readFile("src/components/web-vitals.tsx"), { flag: "wx" }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  const fixture = `
    import React from "react";import {createRoot} from "react-dom/client";import {flushSync} from "react-dom";
    import {WebVitalsReporter} from "./src/components/web-vitals";
    const params=new URLSearchParams(location.search), native=params.has("native");
    const callbacks=[], observers=[], buffer={resource:[],measure:[]}, fetchCalls=[];
    const listeners={pagehide:new Set(),visibilitychange:new Set()};let cause="direct";
    window.__vitalsRegister=callback=>callbacks.push(callback);
    for(const [target,type] of [[window,"pagehide"],[document,"visibilitychange"]]){
      const add=target.addEventListener.bind(target),remove=target.removeEventListener.bind(target);
      target.addEventListener=(name,callback,...rest)=>{if(name===type)listeners[type].add(callback);return add(name,callback,...rest)};
      target.removeEventListener=(name,callback,...rest)=>{if(name===type)listeners[type].delete(callback);return remove(name,callback,...rest)};
    }
    // Capture transport options without replacing the native fetch transport.
    const originalFetch=window.fetch.bind(window);
    window.fetch=(url,init)=>{const item={method:init?.method,keepalive:init?.keepalive,credentials:init?.credentials,body:init?.body,cause};fetchCalls.push(item);sessionStorage.setItem("vitals-fixture-transport",JSON.stringify(fetchCalls));window.recordVitalsFetch(item);return originalFetch(url,init)};
    // These capture listeners are deliberately outside the cleanup counters above.
    EventTarget.prototype.addEventListener.call(window,"pagehide",event=>{if(event.isTrusted)cause="native-pagehide:true"},true);
    EventTarget.prototype.addEventListener.call(document,"visibilitychange",event=>{if(event.isTrusted)cause="native-visibility:true:"+document.visibilityState},true);
    if(!native)window.PerformanceObserver=class{
      constructor(callback){this.callback=callback;this.disconnected=false;this.type="";observers.push(this)}
      observe(options){this.type=options.type;if(params.has("fallback")&&this.type==="resource")throw new Error("Controlled unsupported resource observer");if(options.buffered&&buffer[this.type].length)this.callback({getEntries:()=>buffer[this.type]})}
      disconnect(){this.disconnected=true}
    };
    const originalEntries=performance.getEntriesByType.bind(performance);
    const getEntries=type=>!native&&type==="resource"?buffer.resource:originalEntries(type);
    performance.getEntriesByType=getEntries;
    let root=createRoot(document.getElementById("root"));
    const content=()=>params.get("optin")==="0"?null:<WebVitalsReporter/>;
    const api={
      mount(){if(!root)root=createRoot(document.getElementById("root"));flushSync(()=>root.render(content()))},
      unmount(){if(root){flushSync(()=>root.unmount());root=null}},render(){flushSync(()=>root.render(content()))},
      privacy(dnt,gpc){Object.defineProperty(navigator,"doNotTrack",{configurable:true,get:()=>dnt});Object.defineProperty(navigator,"globalPrivacyControl",{configurable:true,get:()=>gpc})},
      vital(value){for(const callback of callbacks)callback(value)},
      entries(type,entries){buffer[type].push(...entries);for(const observer of observers)if(observer.type===type&&!observer.disconnected)observer.callback({getEntries:()=>entries})},
      event(type){cause="controlled-"+type;if(type==="pagehide")window.dispatchEvent(new Event("pagehide"));else{Object.defineProperty(document,"visibilityState",{configurable:true,get:()=>type==="hidden"?"hidden":"visible"});document.dispatchEvent(new Event("visibilitychange"))}},
      restoreEntries(){performance.getEntriesByType=getEntries},
      nativeMeasure(name,start,duration){return new Promise(resolve=>{const probe=new PerformanceObserver(()=>{probe.disconnect();resolve()});probe.observe({type:"measure"});performance.measure(name,{start,duration})})},
      state(){return {observers:observers.map(({type,disconnected})=>({type,disconnected})),listeners:{pagehide:listeners.pagehide.size,visibilitychange:listeners.visibilitychange.size},registrations:callbacks.length,uniqueCallbacks:new Set(callbacks).size,fetchCalls}}
    };window.vitalsFixture=api;
    api.privacy(params.get("dnt"),params.get("gpc")==="1");api.mount();
    document.getElementById("status").textContent="Фикстура reporter готова";
  `;
  async function bundle(mode: "production" | "development") {
    return (await build({ stdin: { contents: fixture, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": JSON.stringify(mode) }, plugins: [{ name: "controlled-next-metric-input", setup(build) {
      build.onResolve({ filter: /^next\/web-vitals$/ }, () => ({ path: "hook", namespace: "vitals-fixture" }));
      // Installed Next hook registers stable callback in useEffect and has no cleanup. Preserve that behavior.
      build.onLoad({ filter: /.*/, namespace: "vitals-fixture" }, () => ({ contents: 'import {useEffect} from "react";export function useReportWebVitals(callback){useEffect(()=>{window.__vitalsRegister(callback)},[callback])}', loader: "js", resolveDir: process.cwd() }));
    } }] })).outputFiles[0].text;
  }
  const production = await bundle("production"), development = await bundle("development");
  const captures: Capture[] = []; let responseStatus = 204;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
    if (path === "/api/telemetry/vitals") {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      captures.push({ method: req.method ?? "", path, contentType: req.headers["content-type"], body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(responseStatus); res.end(); return;
    }
    if (path === "/fixture.js") { res.setHeader("Content-Type", "text/javascript"); res.end(production); return; }
    if (path === "/development.js") { res.setHeader("Content-Type", "text/javascript"); res.end(development); return; }
    res.setHeader("Content-Type", "text/html");
    res.end(path === "/away" ? '<!doctype html><title>Уход со страницы</title><p>Новый документ</p>' : '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WebVitals lifecycle fixture</title><body style="font:18px system-ui;padding:24px"><h1>Проверка жизненного цикла WebVitals</h1><p id="status">Загрузка</p><div id="root"></div><script src="' + (req.url?.includes("dev=1") ? "/development.js" : "/fixture.js") + '"></script></body></html>');
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const results: Result[] = [];
  const browser = await chromium.launch().catch(async error => { await new Promise<void>(done => server.close(() => done())); throw error; });
  async function run(name: string, action: (page: Page, result: Result) => Promise<void>, query = "", mobile = false) {
    if (caseFilter && !name.includes(caseFilter)) return;
    captures.length = 0; responseStatus = 204;
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
    const page = await context.newPage();
    const result: Result = { name, status: "passed", requests: [], fetchCalls: [], browserErrors: [], blocked: [], evidence: {} };
    page.on("pageerror", error => result.browserErrors.push(error.message));
    await page.exposeFunction("recordVitalsFetch", (item: FetchCall) => { result.fetchCalls.push(item); });
    await context.route("**/*", route => { if (new URL(route.request().url()).origin !== base) { result.blocked.push(route.request().url()); return route.abort(); } return route.continue(); });
    try {
      await page.goto(`${base}/play/private-campaign-id?private=story-prose&${query}`);
      await expect(page.locator("#status")).toHaveText("Фикстура reporter готова");
      if (!query.includes("native=1")) {
        // Install only after loading. Keep the native navigation timing input: Playwright clock
        // otherwise replaces getEntriesByType with an empty-list stub, masking the source route.
        await page.clock.install(); await page.clock.pauseAt(new Date());
        await page.evaluate(() => window.vitalsFixture.restoreEntries());
      }
      await action(page, result);
      expect(result.browserErrors).toEqual([]); expect(result.blocked).toEqual([]);
      await page.screenshot({ path: `${output}/${tag}-${name}.png` });
    } catch (error) { result.status = "failed"; result.error = error instanceof Error ? error.message : String(error); }
    if (result.fetchCalls.length) await expect.poll(() => captures.length).toBe(result.fetchCalls.length).catch(error => { result.status = "failed"; result.error = `${result.error ?? ""}\nHTTP receipt: ${String(error)}`; });
    result.requests = [...captures];
    // Validate every observed transport, including cases with another behavioral failure.
    for (const request of result.requests) {
      try {
        expect(request.method).toBe("POST"); expect(request.path).toBe("/api/telemetry/vitals"); expect(request.contentType).toBe("application/json");
        expect(Object.keys(request.body)).toEqual(["samples"]); expect(request.body.samples.length).toBeLessThanOrEqual(20);
        for (const item of request.body.samples) expect(Object.keys(item).sort()).toEqual(["device", "metric", "navigationType", "route", "value"]);
        expect(JSON.stringify(request.body)).not.toMatch(/private-campaign-id|story-prose|synthetic-metric-id|private-after-navigation|sensitive-resource-query/);
      } catch (error) { result.status = "failed"; result.error = `${result.error ?? ""}\nPayload contract: ${String(error)}`; }
    }
    for (const call of result.fetchCalls) {
      try { expect(call.keepalive).toBe(true); expect(call.credentials).toBe("same-origin"); expect(call.method).toBe("POST"); }
      catch (error) { result.status = "failed"; result.error = `${result.error ?? ""}\nTransport contract: ${String(error)}`; }
    }
    console.log(`${result.status.toUpperCase()} ${name}${result.error ? `: ${result.error}` : ""}`); results.push(result);
    // Closing can deliver a real pagehide. Drain while this scenario still owns its capture array.
    await context.close();
  }
  const emit = (page: Page, input = vital()) => page.evaluate(value => window.vitalsFixture.vital(value), input);
  const event = (page: Page, type: "pagehide" | "hidden" | "visible" = "pagehide") => page.evaluate(value => window.vitalsFixture.event(value), type);
  const unmount = (page: Page) => page.evaluate(() => window.vitalsFixture.unmount());
  const bodies = () => captures.map(item => item.body);
  const expectSent = async (expected: Sample[][]) => { await expect.poll(() => bodies()).toEqual(expected.map(samples => ({ samples }))); };
  const noSend = async (page: Page) => { expect(await page.evaluate(() => window.vitalsFixture.state().fetchCalls)).toEqual([]); expect(captures).toEqual([]); };
  try {
    for (const [name, query] of [["initial-dnt", "dnt=1"], ["initial-gpc", "gpc=1"], ["initial-both", "dnt=1&gpc=1"], ["optin-absent", "optin=0"], ["development-disabled", "dev=1"]]) {
      await run(name, async page => {
        await emit(page); await page.evaluate(() => { window.vitalsFixture.entries("measure", [{ name: "chronicle:turn:first-text", startTime: 1, duration: 17 }]); window.vitalsFixture.entries("resource", [{ name: location.origin + "/api/settings", startTime: 1, duration: 22 }]); });
        await event(page); await event(page, "hidden"); await page.clock.runFor(15_000); await unmount(page); await noSend(page);
        const state = await page.evaluate(() => window.vitalsFixture.state()); expect(state.observers).toEqual([]); expect(state.listeners).toEqual({ pagehide: 0, visibilitychange: 0 });
        expect(state.registrations).toBe(name === "optin-absent" ? 0 : 1);
      }, query);
    }
    for (const mobile of [false, true]) await run(`safe-payload-${mobile ? "mobile" : "desktop"}`, async page => {
      await page.evaluate(() => history.pushState({}, "", "/settings?private=private-after-navigation"));
      await emit(page); await emit(page); await emit(page, { id: "ignored", name: "unknown-prose", value: 1 });
      await page.evaluate(() => window.vitalsFixture.entries("resource", [
        { name: location.origin + "/api/settings?sensitive-resource-query", startTime: 1, duration: 22 },
        { name: "https://external.invalid/api/auth/me", startTime: 2, duration: 33 },
        { name: location.origin + "/api/unrecognized", startTime: 3, duration: 44 },
        { name: "malformed", startTime: 4, duration: 55 },
      ]));
      await event(page); await expectSent([[sample("LCP", 123, "/play/[id]", mobile ? "mobile" : "desktop"), sample("API_SETTINGS", 22, "/settings", mobile ? "mobile" : "desktop", "")]]);
      await event(page); await unmount(page); expect(captures).toHaveLength(1);
    }, "", mobile);
    for (const privacy of ["dnt", "gpc"]) for (const boundary of ["pagehide", "timer", "unmount"] as const) await run(`queued-optout-${privacy}-${boundary}`, async page => {
      await emit(page);
      await page.evaluate(control => window.vitalsFixture.privacy(control === "dnt" ? "1" : null, control === "gpc"), privacy);
      if (boundary === "timer") await page.clock.runFor(15_000); else if (boundary === "unmount") await unmount(page); else await event(page);
      await noSend(page);
      // Opting back in must not resurrect a discarded queued sample.
      await page.evaluate(() => { window.vitalsFixture.privacy(null, false); window.vitalsFixture.mount(); });
      await emit(page, vital("new-after-optin", 456)); await event(page); await expectSent([[sample("LCP", 456)]]); await unmount(page);
    });
    for (const boundary of ["pagehide", "hidden", "unmount"] as const) await run(`drain-once-${boundary}`, async (page, result) => {
      await emit(page); await page.evaluate(entry => window.vitalsFixture.entries("measure", [entry]), measure());
      await event(page, "visible"); expect(captures).toHaveLength(0);
      if (boundary === "unmount") await unmount(page); else await event(page, boundary);
      await expectSent([[sample(), sample("TURN_FIRST_TEXT", 17, "/play/[id]", "desktop", "")]]);
      await event(page); await event(page, "hidden"); await unmount(page); await page.clock.runFor(15_000);
      expect(captures).toHaveLength(1);
      const state = await page.evaluate(() => window.vitalsFixture.state()); expect(state.listeners).toEqual({ pagehide: 0, visibilitychange: 0 }); expect(state.observers.every(item => item.disconnected)).toBe(true); result.evidence.state = state;
    });
    await run("remount-buffered-dedupe", async (page, result) => {
      await emit(page); await page.evaluate(entry => { window.vitalsFixture.entries("measure", [entry]); window.vitalsFixture.entries("resource", [{ name: location.origin + "/api/auth/me", startTime: 1, duration: 22 }]); }, measure());
      await unmount(page); await expectSent([[sample(), sample("TURN_FIRST_TEXT", 17, "/play/[id]", "desktop", ""), sample("API_AUTH", 22, "/play/[id]", "desktop", "")]]);
      await page.evaluate(() => window.vitalsFixture.mount()); await emit(page);
      await page.evaluate(() => { window.vitalsFixture.render(); window.vitalsFixture.entries("resource", [{ name: location.origin + "/api/auth/me", startTime: 2, duration: 33 }]); });
      await event(page); expect(await page.evaluate(() => window.vitalsFixture.state().fetchCalls.length)).toBe(1);
      // Two distinct measures with equal values/timestamps remain two samples (entry identity, not value dedupe).
      await page.evaluate(entries => window.vitalsFixture.entries("measure", entries), [measure(2, 18), measure(2, 18)]);
      await event(page); await expectSent([[sample(), sample("TURN_FIRST_TEXT", 17, "/play/[id]", "desktop", ""), sample("API_AUTH", 22, "/play/[id]", "desktop", "")], [sample("TURN_FIRST_TEXT", 18, "/play/[id]", "desktop", ""), sample("TURN_FIRST_TEXT", 18, "/play/[id]", "desktop", "")]]);
      const mounted = await page.evaluate(() => window.vitalsFixture.state()); expect(mounted.registrations).toBe(2); expect(mounted.uniqueCallbacks).toBe(1); expect(mounted.listeners).toEqual({ pagehide: 1, visibilitychange: 1 }); expect(mounted.observers.filter(item => item.disconnected)).toHaveLength(2);
      await unmount(page); const state = await page.evaluate(() => window.vitalsFixture.state()); expect(state.observers.every(item => item.disconnected)).toBe(true); expect(state.listeners).toEqual({ pagehide: 0, visibilitychange: 0 }); result.evidence.state = state;
    });
    await run("native-observer-remount", async (page, result) => {
      // Actual browser PerformanceMeasure entries and buffered observer replay, without observer stub.
      await page.evaluate(() => window.vitalsFixture.nativeMeasure("chronicle:turn:first-text", 1, 17));
      await unmount(page); await expectSent([[sample("TURN_FIRST_TEXT", 17, "/play/[id]", "desktop", "")]]);
      await page.evaluate(() => window.vitalsFixture.mount());
      // A new native probe observer receives buffered entries after the reporter's observer.
      await page.evaluate(() => new Promise<void>(resolve => { const probe = new PerformanceObserver(() => { probe.disconnect(); resolve(); }); probe.observe({ type: "measure", buffered: true }); }));
      await event(page);
      expect(await page.evaluate(() => window.vitalsFixture.state().fetchCalls.length)).toBe(1);
      await page.evaluate(() => Promise.all([window.vitalsFixture.nativeMeasure("chronicle:turn:first-text", 2, 18), window.vitalsFixture.nativeMeasure("chronicle:turn:first-text", 2, 18)]));
      await event(page); await expectSent([[sample("TURN_FIRST_TEXT", 17, "/play/[id]", "desktop", "")], [sample("TURN_FIRST_TEXT", 18, "/play/[id]", "desktop", ""), sample("TURN_FIRST_TEXT", 18, "/play/[id]", "desktop", "")]]);
      result.evidence.observer = "Native Chromium PerformanceObserver and PerformanceMeasure; Next vital delivery still controlled"; await unmount(page);
    }, "native=1");
    await run("invalid-vital-does-not-poison-id", async page => {
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1]) { await emit(page, vital("retry-id-" + String(value), value)); await emit(page, vital("retry-id-" + String(value), 42)); }
      await event(page); await expectSent([[sample("LCP", 42), sample("LCP", 42), sample("LCP", 42)]]); await unmount(page);
    });
    await run("invalid-resource-does-not-poison-name", async page => {
      await page.evaluate(() => window.vitalsFixture.entries("resource", [
        { name: location.origin + "/api/settings", startTime: 1, duration: NaN },
        { name: location.origin + "/api/auth/me", startTime: 2, duration: -1 },
        { name: location.origin + "/api/workspace", startTime: 3, duration: Infinity },
        { name: location.origin + "/api/settings", startTime: 4, duration: 21 },
        { name: location.origin + "/api/auth/me", startTime: 5, duration: 22 },
        { name: location.origin + "/api/workspace", startTime: 6, duration: 23 },
      ]));
      await event(page); await expectSent([[sample("API_SETTINGS", 21, "/play/[id]", "desktop", ""), sample("API_AUTH", 22, "/play/[id]", "desktop", ""), sample("API_WORKSPACE", 23, "/play/[id]", "desktop", "")]]); await unmount(page);
    });
    await run("resource-observer-fallback", async page => {
      // The buffered resource list exists before a new observer throws.
      await unmount(page); await page.evaluate(() => window.vitalsFixture.entries("resource", [{ name: location.origin + "/api/sessions", startTime: 1, duration: 29 }]));
      await page.evaluate(() => window.vitalsFixture.mount()); await event(page); await expectSent([[sample("API_SESSIONS", 29, "/play/[id]", "desktop", "")]]); await unmount(page);
    }, "fallback=1");
    await run("timer-exact-boundary", async page => {
      await emit(page); await page.clock.runFor(14_999); expect(await page.evaluate(() => window.vitalsFixture.state().fetchCalls)).toEqual([]);
      await page.clock.runFor(1); await expectSent([[sample()]]); await page.clock.runFor(30_000); await event(page); await unmount(page); expect(captures).toHaveLength(1);
    });
    await run("max20-and-remainder", async page => {
      for (let index = 1; index <= 19; index++) await page.evaluate(entry => window.vitalsFixture.entries("measure", [entry]), measure(index, index));
      expect(await page.evaluate(() => window.vitalsFixture.state().fetchCalls)).toEqual([]);
      await page.evaluate(entry => window.vitalsFixture.entries("measure", [entry]), measure(20, 20));
      const first = Array.from({ length: 20 }, (_, index) => sample("TURN_FIRST_TEXT", index + 1, "/play/[id]", "desktop", "")); await expectSent([first]);
      await page.evaluate(entry => window.vitalsFixture.entries("measure", [entry]), measure(21, 21)); await page.clock.runFor(14_999); expect(captures).toHaveLength(1);
      await page.clock.runFor(1); await expectSent([first, [sample("TURN_FIRST_TEXT", 21, "/play/[id]", "desktop", "")]]); await unmount(page);
    });
    await run("http-failure-best-effort", async page => {
      responseStatus = 503; await emit(page); await event(page); await expectSent([[sample()]]);
      await page.clock.runFor(45_000); await event(page); await unmount(page); expect(captures).toHaveLength(1);
    });
    await run("actual-navigation-keepalive", async (page, result) => {
      await emit(page); await page.goto(`${base}/away`); await expectSent([[sample()]]);
      // Exposed async callbacks may disappear on unload. Fixture-only sessionStorage
      // records the safe payload and exact fetch init synchronously before the native call.
      result.fetchCalls = await page.evaluate(() => JSON.parse(sessionStorage.getItem("vitals-fixture-transport") ?? "[]") as FetchCall[]);
      expect(result.fetchCalls).toHaveLength(1);
      expect(result.fetchCalls[0].cause).toMatch(/^native-(pagehide:true|visibility:true:hidden)$/);
      expect(result.fetchCalls[0].keepalive).toBe(true); result.evidence.lifecycle = "Actual document navigation, trusted browser pagehide/visibility event; native fetch reached loopback receiver";
    });
  } finally { await browser.close(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
  const report = { generatedAt: new Date().toISOString(), command: "node --import tsx scripts/web-vitals-lifecycle-p2-browser.ts", boundaries: "Actual WebVitalsReporter and React effects/module queue/sets/listeners. Next hook callback registration stub mirrors installed effect. Deterministic PerformanceObserver except explicitly native observer case; real loopback HTTP fetch. Controlled lifecycle events labeled separately from actual navigation. Opt-in-absent is fixture mount boundary, not deployed Next layout proof. Clock controls timers; no provider/DB/env/production build.", results };
  await writeFile(`${output}/${tag}-result.json`, JSON.stringify(report, null, 2)); await writeFile(`${output}/result.json`, JSON.stringify(report, null, 2));
  console.log(`${results.filter(item => item.status === "passed").length}/${results.length} browser lifecycle scenarios passed`);
  if (results.some(result => result.status === "failed")) process.exitCode = 1;
}
main().catch(error => { console.error("Fixture setup failure (not a product behavioral RED):", error); process.exitCode = 1; });
