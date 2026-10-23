import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { profileIdFromToken } from "../src/lib/guest-identity";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { pollinationsProvider } from "../src/lib/visual-provider";

test("explicit image credentials take precedence over the application key without entering the URL", () => {
  process.env.POLLINATIONS_API_KEY = "synthetic-application-key";
  try {
    const request = pollinationsProvider.buildRequest({ prompt: "tea", seed: 1, width: 64, height: 64, model: "fixture/image" }, "sk_personal_fixture");
    assert.equal(request.headers.Authorization, "Bearer sk_personal_fixture");
    assert.doesNotMatch(request.url, /sk_personal_fixture|synthetic-application-key/);
    assert.throws(() => pollinationsProvider.buildRequest({ prompt: "tea", seed: 1, width: 64, height: 64, model: "fixture/image" }, ""));
  } finally { delete process.env.POLLINATIONS_API_KEY; }
});

test("personal visuals retain payer and model through preference changes, refuse missing personal credentials and isolate owners", async () => {
  const f = await accountsDb(), previousFetch = global.fetch;
  process.env.POLLINATIONS_API_KEY = "synthetic-application-key";
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ test: Buffer.alloc(32, 42).toString("base64") });
  process.env.CHRONICLE_SECRET_ACTIVE_KEY = "test";
  try {
    const preferences = await import("../src/lib/visual-settings");
    const { attachPollinationsKey } = await import("../src/lib/text-provider-settings");
    const { createVisual, renderVisual, listVisuals } = await import("../src/lib/visuals");
    const session = randomUUID();
    await f.pg.query(`INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,'personal-owner','Fixture','{"name":"Анна"}','{"currentLocation":"Кафе"}')`, [session]);
    await attachPollinationsKey("personal-owner", "sk_personal_fixture");
    await attachPollinationsKey("other-owner", "sk_other_owner_fixture");
    await preferences.saveVisualPreferences("personal-owner", { accountSource: "personal", model: "fixture/personal" });
    const personal = await createVisual(session, { kind: "portrait", subject: "hero" });
    assert.equal(personal.accountSource, "personal");
    assert.equal(personal.model, "fixture/personal");
    await preferences.saveVisualPreferences("personal-owner", { accountSource: "application", model: "fixture/new" });
    const requests: { model: string | null; authorization: string | null }[] = [];
    global.fetch = async (url, init) => { requests.push({ model: new URL(String(url)).searchParams.get("model"), authorization: new Headers(init?.headers).get("authorization") }); return new Response(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==", "base64"), { headers: { "Content-Type": "image/png" } }); };
    await f.pg.query("UPDATE ai_settings SET pollinations_key='' WHERE id='personal-owner'");
    await assert.rejects(renderVisual(session, personal.id), /Pollinations/);
    assert.equal(requests.length, 0);
    assert.equal((await f.pg.query<{ attempts: number }>("SELECT attempts FROM scene_visuals WHERE id=$1", [personal.id])).rows[0].attempts, 0);
    await attachPollinationsKey("personal-owner", "sk_personal_fixture");
    await renderVisual(session, personal.id);
    assert.deepEqual(requests, [{ model: "fixture/personal", authorization: "Bearer sk_personal_fixture" }]);
    await preferences.saveVisualPreferences("personal-owner", { accountSource: "personal", model: "fixture/personal" });
    const transferred = await createVisual(session, { kind: "portrait", subject: "hero" });
    await f.pg.query("UPDATE game_sessions SET owner_id='other-owner' WHERE id=$1", [session]);
    await assert.rejects(renderVisual(session, transferred.id), error => (error as { code?: string }).code === "VISUAL_PAYER_CHANGED");
    assert.equal(requests.length, 1, "adoption must not spend the new owner's key or the consumed guest's key");
    assert.equal((await listVisuals(session)).visuals.find(v => v.id === transferred.id)?.generationBlocked, true);
    await renderVisual(session, personal.id);
    assert.equal(requests.length, 1, "ready bytes remain readable without spending after adoption");
    await f.pg.query("UPDATE game_sessions SET owner_id='personal-owner' WHERE id=$1", [session]);
    await preferences.saveVisualPreferences("personal-owner", { accountSource: "application", model: "fixture/new" });
    const shared = await createVisual(session, { kind: "portrait", subject: "hero" });
    await renderVisual(session, shared.id);
    assert.equal(requests[1].authorization, "Bearer synthetic-application-key");
    assert.equal((await listVisuals(session)).visuals.find(v => v.id === personal.id)?.accountSource, "personal");
    assert.equal((await preferences.readVisualConfig("other-owner")).accountSource, "application");
    await preferences.saveVisualPreferences("personal-owner", { accountSource: "personal", model: "fixture/personal" });
    await f.pg.query("UPDATE ai_settings SET pollinations_key_expires_at=now()-interval '1 minute' WHERE id='personal-owner'");
    assert.equal((await preferences.readVisualConfig("personal-owner")).authenticated, false);
    await assert.rejects(createVisual(session, { kind: "portrait" }), /Pollinations/);
  } finally { global.fetch = previousFetch; delete process.env.POLLINATIONS_API_KEY; delete process.env.CHRONICLE_SECRET_KEYS; delete process.env.CHRONICLE_SECRET_ACTIVE_KEY; await f.close(); }
});

test("visual preferences read the owner and application model once without opening unrelated secrets", async () => {
  const f = await accountsDb();
  const { pool } = await import("../src/db");
  const { getVisualPreferences } = await import("../src/lib/visual-settings");
  await f.pg.query("INSERT INTO ai_settings(id,visual_account_source,pollinations_image_model,pollinations_key,openrouter_key,keys) VALUES ('preferences-owner','personal','fixture/personal','sealed-personal-fixture','enc:v1:missing:unrelated','[\"enc:v1:missing:unrelated\"]')");
  await f.pg.query("INSERT INTO visual_settings(id,model) VALUES (1,'fixture/application')");
  const statements: string[] = [];
  const query = mock.method(pool, "query", async (...args: Parameters<typeof f.run>) => {
    statements.push(typeof args[0] === "string" ? args[0] : args[0].text);
    return f.run(...args);
  });
  try {
    const view = await getVisualPreferences("preferences-owner");
    assert.equal(view.accountSource, "personal");
    assert.equal(view.model, "fixture/personal");
    assert.equal(view.applicationModel, "fixture/application");
    assert.equal(view.pollinationsConfigured, true);
    assert.doesNotMatch(JSON.stringify(view), /sealed-personal-fixture|enc:v1|unrelated/);
    assert.equal(statements.length, 2, "one owner read and one application model read are sufficient");
  } finally { query.mock.restore(); await f.close(); }
});

test("visual preference save returns its canonical update with one application read", async () => {
  const f = await accountsDb();
  const { pool } = await import("../src/db");
  const { saveVisualPreferences } = await import("../src/lib/visual-settings");
  await f.pg.query("INSERT INTO ai_settings(id,pollinations_key) VALUES ('save-visual-owner','sealed-personal-fixture')");
  await f.pg.query("INSERT INTO visual_settings(id,model) VALUES (1,'fixture/application')");
  const operations: string[] = [];
  const query = mock.method(pool, "query", async (...args: Parameters<typeof f.run>) => {
    const sql = typeof args[0] === "string" ? args[0] : args[0].text;
    operations.push(sql.trim().split(/\s+/)[0].toLowerCase());
    return f.run(...args);
  });
  try {
    const view = await saveVisualPreferences("save-visual-owner", { accountSource: "personal", model: " fixture/canonical " });
    assert.equal(view.accountSource, "personal");
    assert.equal(view.model, "fixture/canonical");
    assert.equal(view.applicationModel, "fixture/application");
    assert.equal(view.pollinationsConfigured, true);
    assert.deepEqual(operations, ["select", "update", "select"]);
    assert.deepEqual((await f.pg.query("SELECT visual_account_source,pollinations_image_model FROM ai_settings WHERE id='save-visual-owner'")).rows,
      [{ visual_account_source: "personal", pollinations_image_model: "fixture/canonical" }]);
    assert.doesNotMatch(JSON.stringify(view), /sealed-personal-fixture/);
  } finally { query.mock.restore(); await f.close(); }
});

test("visual preference response rechecks identity after a committed update", async () => {
  const f = await accountsDb();
  const { pool } = await import("../src/db");
  const { POST } = await import("../src/app/api/settings/visual-provider/route");
  const guest = "f".repeat(64), owner = profileIdFromToken(guest)!;
  const account = randomUUID();
  await f.pg.query("INSERT INTO accounts(id,login,profile_id,password_hash) VALUES ($1,'visual-fence','other-owner','synthetic')", [account]);
  let revoked = false;
  const query = mock.method(pool, "query", async (...args: Parameters<typeof f.run>) => {
    const sql = typeof args[0] === "string" ? args[0] : args[0].text;
    const result = await f.run(...args);
    if (!revoked && /^update "ai_settings"/i.test(sql)) {
      revoked = true;
      await f.pg.query("INSERT INTO consumed_guest_profiles(profile_id,account_id) VALUES ($1,$2)", [owner, account]);
    }
    return result;
  });
  try {
    const response = await cookieContext(`chronicle_guest=${guest}`, () => POST(new Request("https://fixture.test/api/settings/visual-provider", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountSource: "personal", model: "fixture/image" }),
    })));
    assert.equal(revoked, true);
    assert.equal(response.status, 401);
    assert.equal(Object.hasOwn(await response.json(), "accountSource"), false);
    assert.equal((await f.pg.query<{ n: number }>("SELECT count(*)::int n FROM owner_activity")).rows[0].n, 0);
  } finally { query.mock.restore(); await f.close(); }
});

test("an application visual cannot charge a personal key after preferences switch", async () => {
  const f = await accountsDb();
  const oldFetch = global.fetch, oldKey = process.env.POLLINATIONS_API_KEY;
  process.env.POLLINATIONS_API_KEY = "synthetic-application-key";
  let requests = 0;
  try {
    const { createVisual, renderVisual } = await import("../src/lib/visuals");
    const { saveVisualPreferences } = await import("../src/lib/visual-settings");
    const session = randomUUID();
    await f.pg.query(`INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,'application-payer-owner','Fixture','{"name":"Анна"}','{"currentLocation":"Кафе"}')`, [session]);
    const visual = await createVisual(session, { kind: "portrait", subject: "hero" });
    assert.equal(visual.accountSource, "application");
    await saveVisualPreferences("application-payer-owner", { accountSource: "personal", model: "fixture/personal" });
    await f.pg.query("UPDATE ai_settings SET pollinations_key='personal-credential-must-not-be-opened' WHERE id='application-payer-owner'");
    delete process.env.POLLINATIONS_API_KEY;
    global.fetch = async () => { requests++; throw new Error("Personal fallback must never send a request"); };
    await assert.rejects(renderVisual(session, visual.id), error => (error as { code?: string }).code === "VISUAL_PROVIDER_UNCONFIGURED");
    assert.equal(requests, 0);
    assert.deepEqual((await f.pg.query("SELECT attempts,account_source,model FROM scene_visuals WHERE id=$1", [visual.id])).rows,
      [{ attempts: 0, account_source: "application", model: visual.model }]);
  } finally {
    global.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.POLLINATIONS_API_KEY; else process.env.POLLINATIONS_API_KEY = oldKey;
    await f.close();
  }
});

test("migration 0020 preserves existing visuals and keys with application billing defaults", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE TABLE ai_settings(id text PRIMARY KEY,pollinations_key text NOT NULL);
      CREATE TABLE scene_visuals(id text PRIMARY KEY,model text NOT NULL,prompt text NOT NULL);
      INSERT INTO ai_settings VALUES ('legacy-owner','sealed-legacy-credential');
      INSERT INTO scene_visuals VALUES ('legacy-visual','fixture/legacy','Existing authored illustration');`);
    await pg.exec(await readFile("drizzle/0020_personal_pollinations_visuals.sql", "utf8"));
    assert.deepEqual((await pg.query("SELECT * FROM ai_settings")).rows,
      [{ id: "legacy-owner", pollinations_key: "sealed-legacy-credential", visual_account_source: "application", pollinations_image_model: "" }]);
    assert.deepEqual((await pg.query("SELECT * FROM scene_visuals")).rows,
      [{ id: "legacy-visual", model: "fixture/legacy", prompt: "Existing authored illustration", account_source: "application" }]);
    await assert.rejects(pg.query("UPDATE scene_visuals SET account_source='automatic'"), /check constraint/i);
    await assert.rejects(pg.query("UPDATE ai_settings SET visual_account_source='automatic'"), /check constraint/i);
    await pg.query("UPDATE ai_settings SET visual_account_source='personal',pollinations_image_model='fixture/personal'");
    assert.equal((await pg.query<{ pollinations_key: string }>("SELECT pollinations_key FROM ai_settings")).rows[0].pollinations_key, "sealed-legacy-credential");
  } finally { await pg.close(); }
});
