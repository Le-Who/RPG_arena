import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { profileIdFromToken } from "../src/lib/guest-identity";
import { openSecret, secretContext } from "../src/lib/secret-vault";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

test("visual preference parsing preserves legacy defaults while bounding independent provider and endpoint choices", async () => {
  const { parseVisualPreferences } = await import("../src/lib/visual-settings");
  assert.deepEqual(parseVisualPreferences({ accountSource: "personal", model: " fixture/image " }), { accountSource: "personal", model: "fixture/image", provider: "pollinations", enabled: true, endpoint: null });
  assert.deepEqual(parseVisualPreferences({ enabled: false, provider: "openrouter", accountSource: "personal", model: "fixture/image", endpoint: "fixture-provider" }), { enabled: false, provider: "openrouter", accountSource: "personal", model: "fixture/image", endpoint: "fixture-provider" });
  assert.deepEqual(parseVisualPreferences({ enabled: false, provider: "openrouter", accountSource: "personal", model: "", endpoint: null }), { enabled: false, provider: "openrouter", accountSource: "personal", model: "", endpoint: null });
  for (const input of [
    { enabled: "false", provider: "pollinations", accountSource: "personal", model: "fixture/image" },
    { enabled: null, provider: "pollinations", accountSource: "personal", model: "fixture/image" },
    { provider: null, accountSource: "personal", model: "fixture/image" },
    { provider: "openrouter", accountSource: "application", model: "fixture/image", endpoint: "fixture" },
    { provider: "openrouter", accountSource: "personal", model: "fixture/image" },
    { provider: "openrouter", accountSource: "personal", model: "fixture/image", endpoint: "https://unsafe.invalid" },
    { provider: "pollinations", accountSource: "personal", model: "fixture/image", endpoint: "fixture" },
  ]) assert.throws(() => parseVisualPreferences(input), error => (error as { code?: string }).code === "INVALID_INPUT");
});

test("0021 upgrades populated legacy rows without changing their payer, key, prompt or model", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE TABLE ai_settings(id text PRIMARY KEY,pollinations_key text NOT NULL,pollinations_image_model text NOT NULL,visual_account_source text NOT NULL);
      CREATE TABLE scene_visuals(id text PRIMARY KEY,provider text NOT NULL,account_source text NOT NULL,model text NOT NULL,prompt text NOT NULL);
      INSERT INTO ai_settings VALUES ('legacy-owner','sealed-existing-key','fixture/legacy','personal');
      INSERT INTO scene_visuals VALUES ('legacy-visual','pollinations','personal','fixture/legacy','Existing authored prompt');`);
    await pg.exec(await readFile("drizzle/0021_independent_visual_providers.sql", "utf8"));
    assert.deepEqual((await pg.query("SELECT * FROM ai_settings")).rows, [{ id: "legacy-owner", pollinations_key: "sealed-existing-key", pollinations_image_model: "fixture/legacy", visual_account_source: "personal", visual_enabled: true, visual_provider: "pollinations", visual_model: "fixture/legacy", visual_endpoint: null }]);
    assert.deepEqual((await pg.query("SELECT * FROM scene_visuals")).rows, [{ id: "legacy-visual", provider: "pollinations", account_source: "personal", model: "fixture/legacy", prompt: "Existing authored prompt", endpoint: null, output_format: null }]);
    await assert.rejects(pg.query("UPDATE ai_settings SET visual_provider='openrouter',visual_account_source='application'"), /check constraint/i);
    await assert.rejects(pg.query("UPDATE scene_visuals SET provider='openrouter',account_source='application'"), /check constraint/i);
    await assert.rejects(pg.query("UPDATE scene_visuals SET output_format='svg'"), /check constraint/i);
  } finally { await pg.close(); }
});

test("migration preserves existing visual preferences while genuinely new settings start with optional images off", async () => {
  const f = await accountsDb();
  try {
    const { getRawSettingsRow } = await import("../src/lib/ai-settings");
    const { getVisualPreferences } = await import("../src/lib/visual-settings");
    await f.pg.query("INSERT INTO ai_settings(id,visual_account_source,pollinations_image_model) VALUES ('legacy-visual-owner','personal','fixture/legacy')");
    const legacy = await getVisualPreferences("legacy-visual-owner");
    assert.equal(legacy.enabled, true);
    assert.equal(legacy.provider, "pollinations");
    assert.equal(legacy.model, "fixture/legacy");
    assert.equal(legacy.endpoint, null);
    const created = await getRawSettingsRow("genuinely-new-owner");
    assert.equal(created.visualEnabled, false);
    const initial = await getVisualPreferences("genuinely-new-owner");
    assert.equal(initial.enabled, false);
    assert.equal(initial.provider, "pollinations");
  } finally { await f.close(); }
});

test("shared connections attach and remove encrypted credentials without changing either task or Live preference", async () => {
  const f = await accountsDb();
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ test: Buffer.alloc(32, 42).toString("base64") });
  process.env.CHRONICLE_SECRET_ACTIVE_KEY = "test";
  try {
    const settings = await import("../src/lib/text-provider-settings");
    assert.equal(typeof settings.saveProviderConnection, "function", "shared credential-only save exists");
    await f.pg.query("INSERT INTO ai_settings(id,text_provider,text_model,use_live_ai,visual_account_source,pollinations_image_model) VALUES ('shared-owner','pollinations','fixture/narrator',true,'personal','fixture/picture')");
    for (const provider of ["gemini", "openrouter", "pollinations"] as const) {
      const result = await settings.saveProviderConnection("shared-owner", { provider, apiKey: `synthetic-${provider}` });
      assert.equal(result[`${provider}Configured`], true);
      assert.doesNotMatch(JSON.stringify(result), /synthetic-|enc:v1|fixture\/|useLiveAI/);
    }
    const row = (await f.pg.query<{ keys: string[]; openrouter_key: string; pollinations_key: string }>("SELECT * FROM ai_settings WHERE id='shared-owner'")).rows[0];
    assert.equal(row.keys.length, 1);
    assert.equal(openSecret(row.keys[0], secretContext("shared-owner", "gemini")), "synthetic-gemini");
    assert.equal(openSecret(row.openrouter_key, secretContext("shared-owner", "text:openrouter")), "synthetic-openrouter");
    assert.equal(openSecret(row.pollinations_key, secretContext("shared-owner", "text:pollinations")), "synthetic-pollinations");
    for (const provider of ["gemini", "openrouter", "pollinations"] as const) await settings.saveProviderConnection("shared-owner", { provider, clearKey: true });
    assert.deepEqual(await settings.getProviderConnections("shared-owner"), { geminiConfigured: false, openrouterConfigured: false, pollinationsConfigured: false, openaiConfigured: false });
    assert.deepEqual((await f.pg.query("SELECT text_provider,text_model,use_live_ai,visual_account_source,pollinations_image_model FROM ai_settings WHERE id='shared-owner'")).rows[0], { text_provider: "pollinations", text_model: "fixture/narrator", use_live_ai: true, visual_account_source: "personal", pollinations_image_model: "fixture/picture" });
    assert.deepEqual(await settings.getProviderConnections("other-owner"), { geminiConfigured: false, openrouterConfigured: false, pollinationsConfigured: false, openaiConfigured: false });
    for (const body of [{ provider: "gemini" }, { provider: "openrouter", clearKey: false }, { provider: "pollinations", apiKey: "x", clearKey: true }, { provider: "openrouter", apiKey: "key", model: "bypass" }]) {
      assert.throws(() => settings.parseProviderConnection(body), error => (error as { code?: string }).code === "INVALID_INPUT");
    }
  } finally { delete process.env.CHRONICLE_SECRET_KEYS; delete process.env.CHRONICLE_SECRET_ACTIVE_KEY; await f.close(); }
});

test("OpenRouter visual snapshots survive preference changes and never charge a transferred owner", async () => {
  const f = await accountsDb(), oldFetch = global.fetch;
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ test: Buffer.alloc(32, 42).toString("base64") });
  process.env.CHRONICLE_SECRET_ACTIVE_KEY = "test";
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==";
  const requests: Record<string, unknown>[] = [];
  global.fetch = async (url, init) => {
    if (String(url).endsWith("/endpoints")) return Response.json({ id: "fixture/image", endpoints: [{ provider_name: "Fixture", provider_slug: "fixture-provider", provider_tag: "fixture-provider", supported_parameters: { input_references: { type: "range", min: 0, max: 1 }, output_format: { type: "enum", values: ["png"] } }, pricing: [] }] });
    assert.equal(url, "https://openrouter.ai/api/v1/images");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-router");
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ data: [{ b64_json: png, media_type: "image/png" }] });
  };
  try {
    const { saveVisualPreferences, getVisualPreferences } = await import("../src/lib/visual-settings");
    const settings = await import("../src/lib/text-provider-settings");
    assert.equal(typeof settings.saveProviderConnection, "function", "shared credential-only save exists");
    const { createVisual, renderVisual, listVisuals } = await import("../src/lib/visuals");
    await settings.saveProviderConnection("visual-router-owner", { provider: "openrouter", apiKey: "synthetic-router" });
    await f.pg.query("UPDATE ai_settings SET text_provider='gemini',text_model='narrator-unchanged',use_live_ai=true WHERE id='visual-router-owner'");
    const session = randomUUID();
    await f.pg.query(`INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,'visual-router-owner','Fixture','{"name":"Анна"}','{"currentLocation":"Кафе"}')`, [session]);
    const saved = await saveVisualPreferences("visual-router-owner", { enabled: true, provider: "openrouter", accountSource: "personal", model: "fixture/image", endpoint: "fixture-provider" });
    assert.equal(saved.provider, "openrouter");
    assert.equal(saved.openrouterConfigured, true);
    const visual = await createVisual(session, { kind: "portrait", subject: "hero" });
    assert.equal(visual.endpoint, "fixture-provider");
    assert.equal(visual.outputFormat, "png");
    await saveVisualPreferences("visual-router-owner", { enabled: false, provider: "pollinations", accountSource: "application", model: "fixture/new", endpoint: null });
    assert.equal((await getVisualPreferences("visual-router-owner")).enabled, false);
    await renderVisual(session, visual.id);
    assert.equal(requests[0].model, "fixture/image");
    assert.equal(requests[0].output_format, "png");
    assert.deepEqual(requests[0].provider, { only: ["fixture-provider"], allow_fallbacks: false });
    await f.pg.query("UPDATE scene_visuals SET status='failed',image=null,mime_type=null WHERE id=$1", [visual.id]);
    await settings.saveProviderConnection("visual-router-owner", { provider: "openrouter", clearKey: true });
    await assert.rejects(renderVisual(session, visual.id, { retry: true }), error => (error as { code?: string }).code === "OPENROUTER_CONNECTION_REQUIRED");
    assert.equal(requests.length, 1);
    await settings.saveProviderConnection("visual-router-owner", { provider: "openrouter", apiKey: "synthetic-router" });
    await f.pg.query("UPDATE game_sessions SET owner_id='new-owner' WHERE id=$1", [session]);
    await assert.rejects(renderVisual(session, visual.id, { retry: true }), error => (error as { code?: string }).code === "VISUAL_PAYER_CHANGED");
    assert.equal((await listVisuals(session)).visuals[0].generationBlocked, true);
    assert.equal(requests.length, 1);
    assert.deepEqual((await f.pg.query("SELECT text_provider,text_model,use_live_ai FROM ai_settings WHERE id='visual-router-owner'")).rows[0], { text_provider: "gemini", text_model: "narrator-unchanged", use_live_ai: true });
  } finally { global.fetch = oldFetch; delete process.env.CHRONICLE_SECRET_KEYS; delete process.env.CHRONICLE_SECRET_ACTIVE_KEY; await f.close(); }
});

test("shared credential response rechecks consumed guest identity after its committed write", async () => {
  const f = await accountsDb();
  const settings = await import("../src/lib/text-provider-settings");
  assert.equal(typeof settings.saveProviderConnection, "function", "shared credential-only save exists");
  const { POST } = await import("../src/app/api/settings/provider-connections/route");
  const { pool } = await import("../src/db");
  const guest = "a".repeat(64), owner = profileIdFromToken(guest)!, account = randomUUID();
  await f.pg.query("INSERT INTO accounts(id,login,profile_id,password_hash) VALUES ($1,'connection-fence','other-owner','synthetic')", [account]);
  let revoked = false;
  const query = mock.method(pool, "query", async (...args: Parameters<typeof f.run>) => {
    const sql = typeof args[0] === "string" ? args[0] : args[0].text;
    const result = await f.run(...args);
    if (!revoked && /^update "ai_settings"/i.test(sql)) { revoked = true; await f.pg.query("INSERT INTO consumed_guest_profiles(profile_id,account_id) VALUES ($1,$2)", [owner, account]); }
    return result;
  });
  try {
    const result = await cookieContext(`chronicle_guest=${guest}`, () => POST(new Request("https://fixture.test/api/settings/provider-connections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "openrouter", clearKey: true }) })));
    assert.equal(revoked, true);
    assert.equal(result.status, 401);
    assert.equal(Object.hasOwn(await result.json(), "openrouterConfigured"), false);
  } finally { query.mock.restore(); await f.close(); }
});

test("removing a shared key during endpoint validation stops image spending before an attempt is claimed", async () => {
  const f = await accountsDb(), oldFetch = global.fetch;
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ test: Buffer.alloc(32, 42).toString("base64") });
  process.env.CHRONICLE_SECRET_ACTIVE_KEY = "test";
  let entered!: () => void, release!: () => void, paidRequests = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  global.fetch = async (url) => {
    if (String(url).endsWith("/endpoints")) {
      entered(); await blocked;
      return Response.json({ id: "fixture/removal-race", endpoints: [{ provider_tag: "fixture-race", supported_parameters: { input_references: { type: "range", min: 0, max: 0 } } }] });
    }
    paidRequests++;
    return Response.json({ data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==", media_type: "image/png" }] });
  };
  try {
    const { saveProviderConnection } = await import("../src/lib/text-provider-settings");
    const { renderVisual } = await import("../src/lib/visuals");
    await saveProviderConnection("removed-during-validation", { provider: "openrouter", apiKey: "synthetic-removed-key" });
    const session = randomUUID(), visual = randomUUID();
    await f.pg.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,'removed-during-validation','Fixture','{}','{}')", [session]);
    await f.pg.query("INSERT INTO scene_visuals(id,session_id,owner_id,kind,prompt,provider,account_source,model,endpoint,seed,width,height) VALUES ($1,$2,'removed-during-validation','portrait','Tea','openrouter','personal','fixture/removal-race','fixture-race',1,768,960)", [visual, session]);
    const pending = renderVisual(session, visual);
    await started;
    await saveProviderConnection("removed-during-validation", { provider: "openrouter", clearKey: true });
    release();
    await assert.rejects(pending, error => (error as { code?: string }).code === "OPENROUTER_CONNECTION_REQUIRED");
    assert.equal(paidRequests, 0);
    assert.deepEqual((await f.pg.query("SELECT attempts,status FROM scene_visuals WHERE id=$1", [visual])).rows[0], { attempts: 0, status: "pending" });
  } finally { release(); global.fetch = oldFetch; delete process.env.CHRONICLE_SECRET_KEYS; delete process.env.CHRONICLE_SECRET_ACTIVE_KEY; await f.close(); }
});

test("manual Pollinations IDs cannot bypass known generation exclusions at save, admission or retry", async () => {
  const f = await accountsDb(), oldFetch = global.fetch, oldKey = process.env.POLLINATIONS_API_KEY;
  process.env.POLLINATIONS_API_KEY = "synthetic-application-pollen";
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error("No incompatible image request is permitted"); };
  try {
    const { saveVisualPreferences } = await import("../src/lib/visual-settings");
    const { createVisual, renderVisual } = await import("../src/lib/visuals");
    await assert.rejects(saveVisualPreferences("excluded-owner", { enabled: true, provider: "pollinations", accountSource: "application", model: "prunaai/p-image-edit" }), error => (error as { code?: string }).code === "IMAGE_MODEL_INCOMPATIBLE");
    // An orphaned saved selection remains switchable off while unavailable.
    await saveVisualPreferences("excluded-owner", { enabled: false, provider: "pollinations", accountSource: "application", model: "prunaai/p-image-edit" });
    const session = randomUUID(), visual = randomUUID();
    await f.pg.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,'excluded-owner','Fixture','{}','{}')", [session]);
    await f.pg.query("UPDATE ai_settings SET visual_enabled=true,visual_account_source='personal',pollinations_key='sealed-unused',visual_model='p-image-edit' WHERE id='excluded-owner'");
    await assert.rejects(createVisual(session, { kind: "portrait" }), error => (error as { code?: string }).code === "IMAGE_MODEL_INCOMPATIBLE");
    await f.pg.query("INSERT INTO scene_visuals(id,session_id,owner_id,kind,prompt,provider,account_source,model,seed,width,height,status) VALUES ($1,$2,'excluded-owner','portrait','Tea','pollinations','application','pruna-edit',1,768,960,'failed')", [visual, session]);
    await assert.rejects(renderVisual(session, visual, { retry: true }), error => (error as { code?: string }).code === "IMAGE_MODEL_INCOMPATIBLE");
    assert.equal(calls, 0);
    assert.deepEqual((await f.pg.query("SELECT attempts,status FROM scene_visuals WHERE id=$1", [visual])).rows[0], { attempts: 0, status: "failed" });
    assert.equal((await f.pg.query<{ n: number }>("SELECT count(*)::int n FROM visual_quota_reservations")).rows[0].n, 0);
  } finally { global.fetch = oldFetch; if (oldKey === undefined) delete process.env.POLLINATIONS_API_KEY; else process.env.POLLINATIONS_API_KEY = oldKey; await f.close(); }
});

test("shared connections round trip actual handlers with owner-only flags and no task side effects", async () => {
  const f = await accountsDb();
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ test: Buffer.alloc(32, 42).toString("base64") });
  process.env.CHRONICLE_SECRET_ACTIVE_KEY = "test";
  try {
    const { GET, POST } = await import("../src/app/api/settings/provider-connections/route");
    const guest = "b".repeat(64), other = "c".repeat(64), owner = profileIdFromToken(guest)!;
    await f.pg.query("INSERT INTO ai_settings(id,text_provider,text_model,use_live_ai) VALUES ($1,'openrouter','fixture/narrator',true)", [owner]);
    const post = (body: unknown) => cookieContext(`chronicle_guest=${guest}`, () => POST(new Request("https://fixture.test/api/settings/provider-connections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })));
    const response = await post({ provider: "openrouter", apiKey: "synthetic-shared-handler" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const flags = { geminiConfigured: false, openrouterConfigured: true, pollinationsConfigured: false, openaiConfigured: false };
    assert.deepEqual(await response.json(), flags);
    assert.deepEqual(await (await cookieContext(`chronicle_guest=${guest}`, GET)).json(), flags);
    assert.deepEqual(await (await cookieContext(`chronicle_guest=${other}`, GET)).json(), { ...flags, openrouterConfigured: false });
    assert.equal((await post({ provider: "openrouter", clearKey: true })).status, 200);
    assert.deepEqual((await f.pg.query("SELECT text_provider,text_model,use_live_ai FROM ai_settings WHERE id=$1", [owner])).rows[0], { text_provider: "openrouter", text_model: "fixture/narrator", use_live_ai: true });
    const before = (await f.pg.query("SELECT * FROM ai_settings WHERE id=$1", [owner])).rows[0];
    const denied = await post({ provider: "openrouter", apiKey: "synthetic-injection", ownerId: "other-owner" });
    assert.equal(denied.status, 400);
    assert.deepEqual((await f.pg.query("SELECT * FROM ai_settings WHERE id=$1", [owner])).rows[0], before);
  } finally { delete process.env.CHRONICLE_SECRET_KEYS; delete process.env.CHRONICLE_SECRET_ACTIVE_KEY; await f.close(); }
});

test("unrelated general settings save preserves Live preference after shared credential removal", async () => {
  const f = await accountsDb();
  try {
    const { POST } = await import("../src/app/api/settings/route");
    const { saveProviderConnection } = await import("../src/lib/text-provider-settings");
    const guest = "d".repeat(64), owner = profileIdFromToken(guest)!;
    const post = (body: unknown) => cookieContext(`chronicle_guest=${guest}`, () => POST(new Request("https://fixture.test/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })));
    await f.pg.query("INSERT INTO ai_settings(id,text_provider,text_model,use_live_ai) VALUES ($1,'openrouter','fixture/narrator',true)", [owner]);
    for (const provider of ["openrouter", "pollinations", "gemini"] as const) {
      await f.pg.query("UPDATE ai_settings SET text_provider=$2,use_live_ai=true WHERE id=$1", [owner, provider]);
      await saveProviderConnection(owner, { provider, clearKey: true });
      const response = await post({ enforceLimits: false });
      assert.equal(response.status, 200);
      const view = await response.json();
      assert.equal(view.useLiveAI, true, `${provider}: unrelated writes retain the saved narrator preference`);
      assert.equal(view.canUseLive, false, `${provider}: missing keys still prevent live requests`);
      assert.deepEqual((await f.pg.query("SELECT use_live_ai,enforce_limits FROM ai_settings WHERE id=$1", [owner])).rows[0], { use_live_ai: true, enforce_limits: false });
      const explicitEnable = await post({ useLiveAI: true });
      assert.equal(explicitEnable.status, 200);
      const pending = await explicitEnable.json();
      assert.equal(pending.useLiveAI, true);
      assert.equal(pending.canUseLive, false, "a saved preference cannot make calls without a credential");
    }
  } finally { await f.close(); }
});

test("general settings explicit Gemini key replacement and removal preserve intent and guard readiness", async () => {
  const f = await accountsDb();
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ test: Buffer.alloc(32, 42).toString("base64") });
  process.env.CHRONICLE_SECRET_ACTIVE_KEY = "test";
  try {
    const { POST } = await import("../src/app/api/settings/route");
    const guest = "e".repeat(64), owner = profileIdFromToken(guest)!;
    const post = (body: unknown) => cookieContext(`chronicle_guest=${guest}`, () => POST(new Request("https://fixture.test/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })));
    for (const removal of [{ removeIndex: [0] }, { clearKeys: true }, { keysText: "", append: false }]) {
      const connected = await post({ keysText: "synthetic-legacy-gemini-key", useLiveAI: true });
      assert.equal(connected.status, 200);
      assert.equal((await connected.json()).useLiveAI, true);
      const removed = await post(removal);
      assert.equal(removed.status, 200);
      const view = await removed.json();
      assert.equal(view.useLiveAI, true);
      assert.equal(view.keysCount, 0);
      assert.equal(view.canUseLive, false);
      assert.equal((await f.pg.query<{ use_live_ai: boolean }>("SELECT use_live_ai FROM ai_settings WHERE id=$1", [owner])).rows[0].use_live_ai, true);
    }
  } finally { delete process.env.CHRONICLE_SECRET_KEYS; delete process.env.CHRONICLE_SECRET_ACTIVE_KEY; await f.close(); }
});

test("actual image GET rechecks account revocation after endpoint validation before spending", async () => {
  const f = await accountsDb(), oldFetch = global.fetch;
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ test: Buffer.alloc(32, 42).toString("base64") });
  process.env.CHRONICLE_SECRET_ACTIVE_KEY = "test";
  let entered!: () => void, release!: () => void, paidRequests = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  global.fetch = async (url) => {
    if (String(url).endsWith("/endpoints")) {
      entered(); await blocked;
      return Response.json({ id: "fixture/handler-revocation", endpoints: [{ provider_tag: "fixture-revocation", supported_parameters: { input_references: { type: "range", min: 0, max: 0 } } }] });
    }
    paidRequests++;
    return Response.json({ data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==", media_type: "image/png" }] });
  };
  try {
    const { auth } = await import("../src/lib/auth");
    const { saveProviderConnection } = await import("../src/lib/text-provider-settings");
    const { GET } = await import("../src/app/api/sessions/[id]/visuals/[visualId]/route");
    const account = await auth.register("f".repeat(64), "image-revocation", "correct horse battery staple");
    const owner = account.identity.profileId;
    await saveProviderConnection(owner, { provider: "openrouter", apiKey: "synthetic-revoked-account-key" });
    const session = randomUUID(), visual = randomUUID();
    await f.pg.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,$2,'Fixture','{}','{}')", [session, owner]);
    await f.pg.query("INSERT INTO scene_visuals(id,session_id,owner_id,kind,prompt,provider,account_source,model,endpoint,seed,width,height) VALUES ($1,$2,$3,'portrait','Tea','openrouter','personal','fixture/handler-revocation','fixture-revocation',1,768,960)", [visual, session, owner]);
    const pending = cookieContext(`chronicle_guest=${account.guestToken}; chronicle_session=${account.sessionToken}`, () => GET(new Request(`https://fixture.test/api/sessions/${session}/visuals/${visual}`), { params: Promise.resolve({ id: session, visualId: visual }) }));
    await started;
    await auth.logout(account.sessionToken);
    release();
    const response = await pending;
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, "IDENTITY_CHANGED");
    assert.equal(paidRequests, 0);
    assert.deepEqual((await f.pg.query("SELECT attempts,status FROM scene_visuals WHERE id=$1", [visual])).rows[0], { attempts: 0, status: "pending" });
    assert.equal((await f.pg.query<{ n: number }>("SELECT count(*)::int n FROM owner_activity")).rows[0].n, 0);
  } finally { release(); global.fetch = oldFetch; delete process.env.CHRONICLE_SECRET_KEYS; delete process.env.CHRONICLE_SECRET_ACTIVE_KEY; await f.close(); }
});

test("actual image GET rechecks account revocation again after waiting for an existing lease", async () => {
  const f = await accountsDb(), oldFetch = global.fetch, oldKey = process.env.POLLINATIONS_API_KEY;
  process.env.POLLINATIONS_API_KEY = "synthetic-lease-application-key";
  let paidRequests = 0;
  global.fetch = async () => { paidRequests++; return new Response(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==", "base64"), { headers: { "Content-Type": "image/png" } }); };
  try {
    const { auth } = await import("../src/lib/auth");
    const { pool } = await import("../src/db");
    const { GET } = await import("../src/app/api/sessions/[id]/visuals/[visualId]/route");
    const account = await auth.register("9".repeat(64), "image-lease-revocation", "correct horse battery staple");
    const owner = account.identity.profileId, session = randomUUID(), visual = randomUUID();
    await f.pg.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,$2,'Fixture','{}','{}')", [session, owner]);
    await f.pg.query("INSERT INTO scene_visuals(id,session_id,owner_id,kind,prompt,provider,account_source,model,seed,width,height,attempts) VALUES ($1,$2,$3,'portrait','Tea','pollinations','application','fixture/image',1,768,960,1)", [visual, session, owner]);
    let visualReads = 0, revoked = false;
    const query = mock.method(pool, "query", async (...args: Parameters<typeof f.run>) => {
      const sql = typeof args[0] === "string" ? args[0] : args[0].text;
      const result = await f.run(...args);
      if (/^select .* from "scene_visuals"/i.test(sql) && ++visualReads === 2) {
        await auth.logout(account.sessionToken);
        await f.pg.query("UPDATE scene_visuals SET updated_at=now()-interval '2 minutes' WHERE id=$1", [visual]);
        revoked = true;
      }
      return result;
    });
    try {
      const response = await cookieContext(`chronicle_guest=${account.guestToken}; chronicle_session=${account.sessionToken}`, () => GET(new Request(`https://fixture.test/api/sessions/${session}/visuals/${visual}`), { params: Promise.resolve({ id: session, visualId: visual }) }));
      assert.equal(revoked, true);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).code, "IDENTITY_CHANGED");
      assert.equal(paidRequests, 0);
      assert.deepEqual((await f.pg.query("SELECT attempts,status FROM scene_visuals WHERE id=$1", [visual])).rows[0], { attempts: 1, status: "pending" }, "no second attempt is claimed after revocation");
    } finally { query.mock.restore(); }
  } finally { global.fetch = oldFetch; if (oldKey === undefined) delete process.env.POLLINATIONS_API_KEY; else process.env.POLLINATIONS_API_KEY = oldKey; await f.close(); }
});
