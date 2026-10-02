import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { serviceWorkerSource } from "../src/lib/service-worker-source";

const origin = "https://chronicle.test";
const key = (r: Request | string) => new URL(typeof r === "string" ? r : r.url, origin).href;
type Stores = Map<string, Map<string, Response>>;
function asset(text: string, contentType = "application/javascript", status = 200) {
  const response = new Response(text, { status, headers: { "content-type": contentType } });
  Object.defineProperty(response, "type", { value: "basic" });
  return response;
}
async function worker(build = "build-a", stores: Stores = new Map()) {
  const source = serviceWorkerSource(build);
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const state = { network: asset(build), offline: false, quota: false, skipped: false, claimed: false, reloads: [] as string[], messages: [] as unknown[] };
  const caches = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const stored = stores.get(name)!;
      return {
        match: async (r: Request | string) => {
          const response = stored.get(key(r));
          if (!response) return undefined;
          const clone = response.clone();
          Object.defineProperty(clone, "type", { value: response.type });
          return clone;
        },
        put: async (r: Request | string, v: Response) => { if (state.quota) throw Error("quota"); stored.set(key(r), v); },
        keys: async () => [...stored.keys()].map((url) => new Request(url)),
        delete: async (r: Request | string) => stored.delete(key(r)),
        addAll: async (requests: (Request | string)[]) => {
          if (state.offline || state.quota) throw Error("install failed");
          for (const r of requests) {
            if (typeof r !== "string" && r.cache === "reload") state.reloads.push(key(r));
            stored.set(key(r), asset(build, key(r).endsWith("html") ? "text/html" : "image/png"));
          }
        },
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (r: Request | string) => [...stores.values()].map((s) => s.get(key(r))).find(Boolean)?.clone(),
  };
  runInNewContext(source, {
    self: { location: { origin }, addEventListener: (name: string, fn: (e: Record<string, unknown>) => void) => handlers.set(name, fn), clients: { claim: async () => { state.claimed = true; }, get: async () => ({ postMessage: (message: unknown) => state.messages.push(message) }) }, skipWaiting: async () => { state.skipped = true; } },
    URL, Response, Request, caches,
    fetch: async () => { if (state.offline) throw Error("offline"); return state.network; },
  });
  return { stores, state, count: () => [...stores.values()].reduce((n, s) => n + s.size, 0),
    lifecycle: async (name: string) => { let promise: Promise<unknown> | undefined; handlers.get(name)!({ waitUntil: (p: Promise<unknown>) => { promise = p; } }); await promise; },
    fetch: async (path: string, options: { mode?: string; headers?: Record<string, string>; method?: string } = {}) => {
      let result: Promise<Response> | undefined;
      const work: Promise<unknown>[] = [];
      handlers.get("fetch")!({ clientId: "tab", request: { url: new URL(path, origin).href, method: options.method ?? "GET", mode: options.mode ?? "cors", headers: new Headers(options.headers) }, respondWith: (p: Promise<Response>) => { result = p; }, waitUntil: (p: Promise<unknown>) => work.push(p) });
      const response = result ? await result : null;
      await Promise.all(work);
      return response;
    },
  };
}

test("service worker excludes APIs, RSC, queries, external and private image paths", async () => {
  const w = await worker();
  for (const path of ["/api/session.png", "/private.png", "/_next/image?url=x", "/_next/static/a.js?x=1", "https://other.test/icon.svg"]) assert.equal(await w.fetch(path), null, path);
  assert.equal(await w.fetch("/_next/static/a.js", { headers: { RSC: "1" } }), null);
  assert.equal(await w.fetch("/_next/static/a.js", { headers: { "Next-Router-State-Tree": "x" } }), null);
  assert.equal(await w.fetch("/_next/static/a.js", { method: "POST" }), null);
});

test("service worker never stores HTML, RSC, private or failed asset responses", async () => {
  const w = await worker();
  await w.fetch("/_next/static/a.js");
  assert.equal(w.count(), 1);
  for (const [index, response] of [asset("private", "text/html"), asset("rsc", "text/x-component"), asset("missing", "text/plain", 404), asset("private")].entries()) {
    if (index === 3) response.headers.set("Cache-Control", "private, no-store");
    w.state.network = response;
    await w.fetch(`/_next/static/b${index}.js`);
  }
  await w.fetch("/play/private", { mode: "navigate" });
  assert.equal(w.count(), 1);
});

test("new build refreshes its own shell, claims tabs and retains previous hashed chunks", async () => {
  const a = await worker();
  await a.lifecycle("install");
  await a.fetch("/_next/static/chunks/old-hash.js");
  const b = await worker("build-b", a.stores);
  await b.lifecycle("install");
  await b.lifecycle("activate");
  assert.equal(b.state.skipped, true);
  assert.equal(b.state.claimed, true);
  assert.equal(b.state.reloads.length, 4);
  b.state.offline = true;
  assert.equal(await (await b.fetch("/_next/static/chunks/old-hash.js"))!.text(), "build-a");
  assert.equal(await (await b.fetch("/story", { mode: "navigate" }))!.text(), "build-b");
  assert.equal(await (await b.fetch("/icon.svg"))!.text(), "build-b");
});

test("quota errors do not discard a successful network asset", async () => {
  const w = await worker();
  w.state.quota = true;
  assert.equal(await (await w.fetch("/_next/static/chunks/new.js"))!.text(), "build-a");
});

test("failed install leaves the current worker in control", async () => {
  const w = await worker();
  w.state.offline = true;
  await assert.rejects(w.lifecycle("install"));
  assert.equal(w.state.skipped, false);
});

test("shared asset cache stays bounded across releases", async () => {
  const w = await worker();
  for (let i = 0; i < 175; i++) await w.fetch(`/_next/static/chunks/${i}.js`);
  assert.ok(w.count() <= 160);
});

test("legacy static caches migrate only immutable assets and offline fallback uses the current shell", async () => {
  const stores: Stores = new Map([
    ["chronicle-shell-v2-static", new Map([
      [key("/_next/static/legacy.js"), asset("legacy")],
      [key("/icon.svg"), asset("old icon", "image/svg+xml")],
      [key("/api/private"), asset("private")],
    ])],
    ["unrelated-cache", new Map([[key("/offline.html"), asset("unrelated")]])],
  ]);
  const w = await worker("build-b", stores);
  await w.lifecycle("install");
  await w.lifecycle("activate");
  w.state.offline = true;
  assert.equal(await (await w.fetch("/_next/static/legacy.js"))!.text(), "legacy");
  assert.equal(await (await w.fetch("/icon.svg"))!.text(), "build-b");
  assert.equal(await (await w.fetch("/story", { mode: "navigate" }))!.text(), "build-b");
  assert.equal(stores.has("chronicle-shell-v2-static"), false);
  assert.equal(stores.has("unrelated-cache"), true);
  assert.ok(![...stores.values()].some((s) => s.has(key("/api/private"))));
});

test("shell cleanup stays bounded without dropping current or previous shell", async () => {
  const stores: Stores = new Map();
  for (const build of ["a", "b", "c", "d"]) {
    const w = await worker(build, stores);
    await w.lifecycle("install");
    await w.lifecycle("activate");
  }
  assert.deepEqual([...stores.keys()].filter((k) => k.startsWith("chronicle-offline-")).sort(), ["chronicle-offline-c", "chronicle-offline-d"]);
});

test("missing chunks inform their tab and remain uncached", async () => {
  const w = await worker();
  w.state.network = asset("missing", "text/plain", 404);
  assert.equal((await w.fetch("/_next/static/missing.js"))!.status, 404);
  assert.equal(JSON.stringify(w.state.messages), '[{"type":"chronicle:asset-unavailable"}]');
  assert.equal(w.count(), 0);
});
