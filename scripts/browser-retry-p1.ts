/** Production React and actual route handlers over a fixture-only native PostgreSQL bridge.
 * Run with the safe preload and CHRONICLE_RUN_BROWSER_RETRY_POSTGRES=1. Never reads .env.
 * Native PG has no pgvector: 0006 remains immutable and is explicitly outside this fixture.
 */
import { chromium, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { cookieContext } from "../tests/helpers/accounts-db";
import { portableFixture } from "../tests/helpers/portable-fixture";
import { mockSnapshot, mockSessionId } from "./ui-mock";

const output = "output/p1-continuation/browser-retry";
function gate() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; }
async function main() {
  assert.equal(process.env.CHRONICLE_RUN_BROWSER_RETRY_POSTGRES, "1", "explicit fixture opt-in is required");
  assert.equal(process.env.DATABASE_URL, "postgresql://test:test@127.0.0.1:1/chronicle_test", "use tests/helpers/test-environment.ts preload");
  for (const name of ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "PGSERVICE", "PGOPTIONS", "PGSSLMODE"]) delete process.env[name];
  await mkdir(output, { recursive: true });
  const schema = `browser_retry_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, /^browser_retry_[a-f0-9]{32}$/);
  const url = new URL("postgresql://chronicle_test:fixture-only@127.0.0.1:55439/chronicle_auth_test");
  const bootstrap = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  try { await bootstrap.query(`CREATE SCHEMA "${schema}"`); }
  catch (error) { await bootstrap.end(); throw error; }
  url.searchParams.set("options", `-csearch_path=${schema},public`);
  process.env.DATABASE_URL = url.toString();
  const { pool } = await import("../src/db");
  const requests: { kind: string; body: Record<string, unknown>; status?: number; sessionId?: string }[] = [];
  const browserErrors: string[] = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const migrations = (await readdir("drizzle")).filter(file => /^\d{4}_.*\.sql$/.test(file) && !file.startsWith("0006_")).sort();
    for (const file of migrations) await pool.query((await readFile(`drizzle/${file}`, "utf8")).replaceAll('"public".', `"${schema}".`));
    const { auth } = await import("../src/lib/auth");
    const { newGuestToken } = await import("../src/lib/guest-identity");
    const account = await auth.register(newGuestToken(), "browser-retry", "fixture password only 2026");
    const owner = account.identity.profileId;
    const { POST: importPOST } = await import("../src/app/api/sessions/import/route");
    const { POST: actPOST } = await import("../src/app/api/sessions/[id]/act/route");
    const { GET: requestGET } = await import("../src/app/api/sessions/[id]/requests/[requestId]/route");
    const { GET: snapshotGET } = await import("../src/app/api/sessions/[id]/route");
    const { createPortableDocument } = await import("../src/lib/campaign-portable");
    const portableDocument = createPortableDocument(portableFixture());
    const nativeSession = randomUUID();
    await pool.query("INSERT INTO game_sessions(id,owner_id,title,scenario_id,campaign_mode,rules_profile,character,world_state,turn_count) VALUES ($1,$2,'Безопасная гавань','ashen-crown','preset','d20',$3,$4,1)", [nativeSession, owner, mockSnapshot.session.character, mockSnapshot.session.worldState]);
    await pool.query("INSERT INTO game_turns(session_id,turn_number,role,content,choices) VALUES ($1,1,'narrator','Тихое утро в гавани.',$2)", [nativeSession, JSON.stringify(["Осмотреться"])]);
    await pool.query("INSERT INTO ai_settings(id,use_live_ai,embeddings_enabled,semantic_extraction_enabled) VALUES ($1,false,false,false)", [owner]);

    const appStub = `const app={identity:${JSON.stringify(account.identity)},settings:{useLiveAI:false,keysCount:0,envKeysCount:0},sessions:[],workspace:{reading:{motion:"reduced"}},refresh:async()=>{document.body.dataset.refreshed="yes"},notify:message=>{document.body.dataset.notification=message},resolveNotification:()=>{},setPlayCommands:()=>{},loading:false};export function useApp(){return app}`;
    const bundle = await build({ stdin: { contents: `
      import React from "react";import {createRoot} from "react-dom/client";
      import {PlayRoom} from "./src/components/play-room";import {CampaignImport} from "./src/components/campaign-import";
      const sessionId=new URLSearchParams(location.search).get("session")||"${mockSessionId}";
      createRoot(document.getElementById("root")).render(location.pathname==="/import"?<CampaignImport/>:<PlayRoom sessionId={sessionId}/>);
    `, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, outfile: "fixture.js", platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_CHRONICLE_BUILD_ID": '"browser-retry-fixture"' }, plugins: [{ name: "fixture-shell-router", setup(build) {
      build.onResolve({ filter: /(?:^|\/)app-shell$/ }, () => ({ path: "app-shell", namespace: "fixture" }));
      build.onResolve({ filter: /^next\/(navigation|link)$/ }, args => ({ path: args.path, namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path === "app-shell" ? appStub : args.path === "next/navigation" ? 'export function useRouter(){return {push:url=>{document.body.dataset.navigation=url}}};export function usePathname(){return location.pathname}' : 'import React from "react";export default function Link({href,children,...props}){return <a href={href} {...props}>{children}</a>}', loader: "tsx", resolveDir: process.cwd() }));
    } }] });
    const js = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
    const css = (await Promise.all(["globals", "theatre", "life", "dialogs"].map(name => readFile(`src/app/${name}.css`, "utf8")))).join("\n").replace('@import "tailwindcss";', "") + (bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "");
    const html = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><body><main id="root"></main><script src="/fixture.js"></script></body></html>';
    let imports = 0, acts = 0, nativePolls = 0;
    let allowNativePoll = false;
    server = createServer(async (req, res) => {
      try {
        const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
        if (!requestUrl.pathname.startsWith("/api/")) {
          res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : req.url === "/fixture.css" ? "text/css" : "text/html");
          res.end(req.url === "/fixture.js" ? js : req.url === "/fixture.css" ? css : html); return;
        }
        let body = ""; for await (const part of req) body += part;
        const requestCookie = req.headers.cookie ?? "";
        const match = requestUrl.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(act|requests)\/?([^/]+)?)?$/);
        if (requestUrl.pathname === "/api/sessions/import" || match?.[1] === nativeSession) assert.ok(requestCookie.includes(`chronicle_guest=${account.guestToken}`) && requestCookie.includes(`chronicle_session=${account.sessionToken}`), "browser must dispatch the registered account cookies");
        const webRequest = new Request(requestUrl, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")), ...(body ? { body } : {}) });
        let response: Response;
        let entry: typeof requests[number] | undefined;
        if (requestUrl.pathname === "/api/sessions/import") {
          imports++; entry = { kind: "import", body: JSON.parse(body) }; requests.push(entry);
          response = await cookieContext(requestCookie, () => importPOST(webRequest));
        } else if (match?.[1] === nativeSession) {
          if (match[2] === "act") { acts++; entry = { kind: "act", body: JSON.parse(body) }; requests.push(entry); response = await cookieContext(requestCookie, () => actPOST(webRequest, { params: Promise.resolve({ id: nativeSession }) })); }
          else if (match[2] === "requests") {
            nativePolls++;
            if (!allowNativePoll) { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"code":"NOT_FOUND"}'); return; }
            response = await cookieContext(requestCookie, () => requestGET(webRequest, { params: Promise.resolve({ id: nativeSession, requestId: match[3] }) }));
          } else response = await cookieContext(requestCookie, () => snapshotGET(webRequest, { params: Promise.resolve({ id: nativeSession }) }));
        } else { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"code":"FIXTURE_UNHANDLED"}'); return; }
        // Drain the actual response so the native commit finishes before dropping its delivery.
        const text = await response.text();
        if (entry) { entry.status = response.status; if (entry.kind === "import" && response.ok) entry.sessionId = JSON.parse(text).session.id; }
        if ((entry?.kind === "import" && imports === 1 || entry?.kind === "act" && acts === 1) && response.ok) {
          // Send partial delivery before reset so Chromium cannot transparently retry a never-started HTTP response.
          res.writeHead(response.status, Object.fromEntries(response.headers)); res.write(text.slice(0, 10)); res.flushHeaders();
          setTimeout(() => res.destroy(), 25); return;
        }
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(text);
      } catch (error) { browserErrors.push(String(error)); res.writeHead(500); res.end("fixture bridge failed"); }
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await chromium.launch();
    const watch = (page: Page) => page.on("pageerror", error => { browserErrors.push(error.message); console.error("browser pageerror:", error.message); });

    // Browser POST -> real import handler -> committed native SQL, then lost delivery -> same-ID retry.
    const importPage = await browser.newPage({ viewport: { width: 390, height: 844 } }); watch(importPage);
    await importPage.context().addCookies([{ name: "chronicle_guest", value: account.guestToken, url: base, httpOnly: true }, { name: "chronicle_session", value: account.sessionToken, url: base, httpOnly: true }]);
    await importPage.goto(`${base}/import`);
    await importPage.getByRole("button", { name: "Импорт кампании", exact: true }).click();
    await importPage.locator('input[type="file"]').setInputFiles({ name: "harbor.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(portableDocument)) });
    const submitImport = importPage.getByRole("button", { name: "Импортировать", exact: true });
    await expect(submitImport).toBeEnabled(); await submitImport.focus(); await importPage.keyboard.press("Enter");
    await expect(importPage.getByRole("alert")).toBeVisible();
    await importPage.screenshot({ path: `${output}/import-mobile.png`, fullPage: true });
    assert.equal(await importPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(requests[0].status, 201);
    assert.equal(Number((await pool.query("SELECT count(*)::int n FROM game_sessions WHERE owner_id=$1 AND id<>$2", [owner, nativeSession])).rows[0].n), 1);
    await importPage.keyboard.press("Escape");
    await expect(importPage.getByRole("dialog")).toHaveCount(0);
    await importPage.getByRole("button", { name: "Импорт кампании", exact: true }).click();
    await expect(importPage.getByText("Выбран файл: harbor.json", { exact: true })).toBeVisible();
    await submitImport.click();
    await expect.poll(() => importPage.evaluate(() => document.body.dataset.navigation)).toBe(`/play/${requests[0].sessionId}`);
    assert.deepEqual(requests.filter(entry => entry.kind === "import").map(entry => entry.status), [201, 200]);
    assert.deepEqual(requests[1].body, requests[0].body, "retry preserves the original requestId and document across dialog closure");
    assert.equal(requests[1].sessionId, requests[0].sessionId);
    assert.equal(Number((await pool.query("SELECT count(*)::int n FROM campaign_imports WHERE owner_id=$1", [owner])).rows[0].n), 1);
    assert.equal(Number((await pool.query("SELECT count(*)::int n FROM game_sessions WHERE owner_id=$1 AND id<>$2", [owner, nativeSession])).rows[0].n), 1);
    await importPage.close();

    // Actual offline preset act loses delivery; a page reload recovers from the real request ledger.
    const nativePage = await browser.newPage({ viewport: { width: 1440, height: 900 } }); watch(nativePage);
    await nativePage.context().addCookies([{ name: "chronicle_guest", value: account.guestToken, url: base, httpOnly: true }, { name: "chronicle_session", value: account.sessionToken, url: base, httpOnly: true }]);
    await nativePage.goto(`${base}/play?session=${nativeSession}`);
    const nativeInput = nativePage.locator("#action-input"); await expect(nativeInput).toBeEnabled();
    await nativeInput.fill("Осмотреться"); await nativeInput.press("Control+Enter");
    await expect.poll(() => requests.find(entry => entry.kind === "act")?.status).toBe(200);
    const act = requests.find(entry => entry.kind === "act")!;
    const pending = JSON.parse((await nativePage.evaluate(id => sessionStorage.getItem(`chronicle:pending:${id}`), nativeSession))!);
    assert.equal(pending.id, act.body.requestId); assert.equal(pending.expectedTurn, 1); assert.equal(pending.action, "Осмотреться");
    const durable = (await pool.query("SELECT turn_count,character,world_state FROM game_sessions WHERE id=$1", [nativeSession])).rows[0];
    assert.equal(durable.turn_count, 2);
    const ledger = (await pool.query("SELECT status,result FROM turn_requests WHERE session_id=$1 AND request_id=$2", [nativeSession, pending.id])).rows[0];
    assert.equal(ledger.status, "completed"); assert.equal(ledger.result.turnNumber, 2);
    assert.deepEqual(ledger.result.state.character, durable.character); assert.deepEqual(ledger.result.state.worldState, durable.world_state);
    allowNativePoll = true; await nativePage.reload();
    await expect(nativePage.locator("#turn-2 .gx-prose")).toHaveText(ledger.result.narration);
    await expect(nativePage.locator(".gx-vital-head strong")).toHaveText(`${durable.character.hp} / ${durable.character.maxHp}`);
    await expect(nativePage.locator(".gx-topbar-title")).toHaveText(durable.world_state.currentLocation);
    await expect(nativeInput).toBeEnabled();
    await expect.poll(() => nativePage.evaluate(id => sessionStorage.getItem(`chronicle:pending:${id}`), nativeSession)).toBeNull();
    assert.equal(acts, 1, "reload recovery must not send another act");
    assert.ok(nativePolls > 0);
    assert.equal(Number((await pool.query("SELECT count(*)::int n FROM turn_requests WHERE session_id=$1", [nativeSession])).rows[0].n), 1);
    assert.deepEqual((await pool.query("SELECT turn_number,role,content FROM game_turns WHERE session_id=$1 AND turn_number=2 ORDER BY role", [nativeSession])).rows,
      [{ turn_number: 2, role: "narrator", content: ledger.result.narration }, { turn_number: 2, role: "player", content: "Осмотреться" }]);
    await nativePage.screenshot({ path: `${output}/native-recovered-desktop.png`, fullPage: true }); await nativePage.close();

    // Deliberately inconsistent transport responses exercise the real PlayRoom/hook state guard.
    for (const verifiedTurn of [4, 5]) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); watch(page);
      const pollGate = gate(), refreshGate = gate(); let snapshots = 0;
      const verified = { ...structuredClone(mockSnapshot), turns: structuredClone(mockSnapshot.turns) as Record<string, unknown>[] };
      verified.session.ownerId = owner; verified.session.turnCount = verifiedTurn; verified.session.character.hp = 9;
      verified.session.worldState.currentLocation = "Проверенный сад";
      verified.turns.push({ ...verified.turns[0], id: "verified-row", turnNumber: verifiedTurn, content: "Принятый рассказ", choices: ["Продолжить в саду"] });
      await page.addInitScript(({ id }) => sessionStorage.setItem(`chronicle:pending:${id}`, JSON.stringify({ id: "restored-request", sessionId: id, action: "Сохранённое действие", custom: true, expectedTurn: 3 })), { id: mockSessionId });
      await page.route(`**/api/sessions/${mockSessionId}?*`, async route => { snapshots++; if (snapshots > 1) await refreshGate.promise; await route.fulfill({ json: { ...verified, isOwner: true } }); });
      await page.route("**/requests/*", async route => { await pollGate.promise; await route.fulfill({ json: { requestId: "restored-request", status: "completed", stage: "completed", baseTurn: 3, retryAfter: 0, error: null, result: {
        ok: true, requestId: "restored-request", turnNumber: 4, narration: "Старый рассказ", choices: ["Старый выбор"], dice: null, outcome: "success", applied: { hp: 0, xp: 0, gold: 0, danger: 0, levelUp: false, dead: false, location: null, quests: [], npcs: [], inventory: [], sceneObjects: [], conditions: { added: [], removed: [] }, rejected: [] },
        modelUsed: "synthetic", taskType: "narration", needsCompaction: false, dead: false, retrieved: [], skippedModels: [], warnings: [], state: { character: { ...verified.session.character, hp: 1 }, worldState: { ...verified.session.worldState, currentLocation: "Старый причал" } },
      } } }); });
      await page.goto(`${base}/play`); await expect(page.getByText("Проверенный сад", { exact: true }).first()).toBeVisible();
      pollGate.open(); await expect.poll(() => page.evaluate(id => sessionStorage.getItem(`chronicle:pending:${id}`), mockSessionId)).toBeNull();
      await expect(page.locator(".gx-vital-head strong")).toHaveText("9 / 24");
      await expect(page.getByText("Проверенный сад", { exact: true }).first()).toBeVisible();
      await expect(page.locator(`#turn-${verifiedTurn} .gx-prose`)).toHaveText("Принятый рассказ");
      await expect(page.getByRole("button", { name: /Продолжить в саду/ })).toBeVisible();
      refreshGate.open(); await page.close();
    }
    assert.deepEqual(browserErrors, []);
    await writeFile(`${output}/result.json`, JSON.stringify({ schema, migrations, excludedMigration: "0006_database_memory_search.sql (pgvector unavailable; no full replay/readiness claim)", checks: ["import native commit with dropped response", "same-ID import retry after keyboard dialog closure", "one campaign and one import ledger row", "actual offline act native commit and lost delivery", "reload polls actual ledger without second act", "ledger state equals durable native state", "older and equal turn recovery preserve verified PlayRoom state and choices"], requests: requests.map(({ kind, body, status, sessionId }) => ({ kind, requestId: body.requestId, status, sessionId })), browserErrors }, null, 2));
    console.log(`PASS: browser retry contracts, native handlers and durable relational SQL; artifacts ${output}`);
  } finally {
    await writeFile(`${output}/last-requests.json`, JSON.stringify(requests.map(entry => ({ kind: entry.kind, requestId: entry.body.requestId, status: entry.status, sessionId: entry.sessionId })), null, 2));
    if (browser) for (const context of browser.contexts()) for (const [index, page] of context.pages().entries()) {
      await writeFile(`${output}/last-page-${index}.html`, await page.content()).catch(() => undefined);
    }
    await browser?.close(); server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await pool.end(); await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`); await bootstrap.end();
  }
}
void main().catch(async error => { await mkdir(output, { recursive: true }); await writeFile(`${output}/failure.txt`, String(error.stack ?? error)); console.error(error); process.exitCode = 1; });
