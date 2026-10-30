import test from "node:test";
import assert from "node:assert/strict";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { profileIdFromToken } from "../src/lib/guest-identity";
import { openSecret, sealSecret, secretContext } from "../src/lib/secret-vault";

const guest = "f".repeat(64), owner = profileIdFromToken(guest)!;
const cookie = `chronicle_guest=${guest}`;
const broken = "enc:v1:missing:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AA";
function installKeyring() {
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ recovery: Buffer.alloc(32, 83).toString("base64") });
  process.env.CHRONICLE_SECRET_ACTIVE_KEY = "recovery";
}
function clearKeyring() {
  delete process.env.CHRONICLE_SECRET_KEYS;
  delete process.env.CHRONICLE_SECRET_ACTIVE_KEY;
}
function post(handler: (request: Request) => Promise<Response>, body: unknown, identity = cookie) {
  return cookieContext(identity, () => handler(new Request("https://game.test/api/settings", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })));
}

test("bootstrap and settings keep campaigns accessible with legacy, damaged or unavailable encryption keys", async () => {
  const f = await accountsDb();
  try {
    const { GET: bootstrap } = await import("../src/app/api/bootstrap/route");
    const { GET: settings } = await import("../src/app/api/settings/route");
    installKeyring();
    const sealed = sealSecret("synthetic-unavailable-key", secretContext(owner, "gemini"));
    clearKeyring();
    await f.pg.query("INSERT INTO game_sessions(title,owner_id,character,world_state) VALUES ('Старая история',$1,'{}','{}')", [owner]);
    await f.pg.query("INSERT INTO ai_settings(id,use_live_ai) VALUES ($1,true)", [owner]);
    for (const key of ["synthetic-legacy-key", broken, sealed]) {
      await f.pg.query("UPDATE ai_settings SET keys=$2::jsonb WHERE id=$1", [owner, JSON.stringify([key])]);
      const response = await cookieContext(cookie, () => bootstrap());
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.identity.profileId, owner);
      assert.deepEqual(body.sessions.map((session: { title: string }) => session.title), ["Старая история"]);
      assert.deepEqual(body.settings.credentialIssues, ["gemini"]);
      assert.deepEqual(body.settings.keysMasked, ["••••"]);
      assert.equal(body.settings.canUseLive, false);
      assert.equal(body.settings.useLiveAI, true, "a read must retain the saved preference");
      assert.ok(!JSON.stringify(body).includes(key));
      assert.equal((await cookieContext(cookie, () => settings())).status, 200);
      assert.deepEqual((await f.pg.query("SELECT keys FROM ai_settings WHERE id=$1", [owner])).rows, [{ keys: [key] }]);
    }
    const other = await cookieContext(`chronicle_guest=${"e".repeat(64)}`, () => bootstrap());
    const otherBody = await other.json();
    assert.equal(other.status, 200);
    assert.deepEqual(otherBody.sessions, []);
    assert.equal(otherBody.settings.credentialIssues, undefined);
  } finally { clearKeyring(); await f.close(); }
});

test("registration and re-login retain access to campaigns despite a legacy credential", async () => {
  const f = await accountsDb();
  try {
    const { auth } = await import("../src/lib/auth");
    const { GET } = await import("../src/app/api/bootstrap/route");
    await f.pg.query("INSERT INTO ai_settings(id,keys) VALUES ($1,$2::jsonb)", [owner, JSON.stringify(["synthetic-old-key"])]);
    await f.pg.query("INSERT INTO game_sessions(title,owner_id,character,world_state) VALUES ('История аккаунта',$1,'{}','{}')", [owner]);
    const registered = await auth.register(guest, "credential-recovery", "synthetic recovery password");
    const loggedIn = await auth.login(registered.guestToken, "credential-recovery", "synthetic recovery password");
    for (const identity of [registered, loggedIn]) {
      const response = await cookieContext(`chronicle_guest=${identity.guestToken}; chronicle_session=${identity.sessionToken}`, () => GET());
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.identity.kind, "account");
      assert.equal(body.identity.isAdmin, false);
      assert.equal(body.sessions[0].title, "История аккаунта");
      assert.deepEqual(body.settings.credentialIssues, ["gemini"]);
    }
  } finally { await f.close(); }
});

test("ordinary users can replace each unreadable service credential without reading or overwriting other secrets", async () => {
  const f = await accountsDb();
  installKeyring();
  try {
    const connections = await import("../src/app/api/settings/provider-connections/route");
    const { GET: bootstrap } = await import("../src/app/api/bootstrap/route");
    await f.pg.query("INSERT INTO ai_settings(id,keys,openrouter_key,pollinations_key,use_live_ai) VALUES ($1,$2::jsonb,$3,$3,true)", [owner, JSON.stringify([broken]), broken]);
    const loaded = await cookieContext(cookie, () => connections.GET());
    assert.equal(loaded.status, 200);
    assert.deepEqual((await loaded.json()).credentialIssues, ["gemini", "openrouter", "pollinations"]);
    for (const provider of ["gemini", "openrouter", "pollinations"] as const) {
      const apiKey = `synthetic-replacement-${provider}`;
      const response = await post(connections.POST, { provider, apiKey });
      assert.equal(response.status, 200);
      assert.ok(!JSON.stringify(await response.json()).includes(apiKey));
      const row = (await f.pg.query<{ keys: string[]; openrouter_key: string; pollinations_key: string }>("SELECT keys,openrouter_key,pollinations_key FROM ai_settings WHERE id=$1", [owner])).rows[0];
      const value = provider === "gemini" ? row.keys[0] : row[`${provider}_key`];
      assert.equal(openSecret(value, secretContext(owner, provider === "gemini" ? "gemini" : `text:${provider}`)), apiKey);
      assert.throws(() => openSecret(value, secretContext("another-owner", provider === "gemini" ? "gemini" : `text:${provider}`)));
      if (provider === "gemini") assert.equal(row.openrouter_key, broken);
      if (provider !== "pollinations") assert.equal(row.pollinations_key, broken);
    }
    const recovered = await cookieContext(cookie, () => bootstrap());
    const body = await recovered.json();
    assert.equal(recovered.status, 200);
    assert.equal(body.settings.credentialIssues, undefined);
    assert.equal(body.settings.canUseLive, true);
  } finally { clearKeyring(); await f.close(); }
});

test("general settings updates preserve unreadable keys; explicit replacement, removal and clearing recover them", async () => {
  const f = await accountsDb();
  installKeyring();
  try {
    const { POST } = await import("../src/app/api/settings/route");
    await f.pg.query("INSERT INTO ai_settings(id,keys,use_live_ai) VALUES ($1,$2::jsonb,true)", [owner, JSON.stringify([broken])]);
    assert.equal((await post(POST, { dailyFlashLimit: 42 })).status, 200);
    assert.deepEqual((await f.pg.query("SELECT keys,daily_flash_limit FROM ai_settings WHERE id=$1", [owner])).rows, [{ keys: [broken], daily_flash_limit: 42 }]);
    assert.equal((await post(POST, { keysText: "synthetic-new-gemini-key", append: false })).status, 200);
    const replacement = (await f.pg.query<{ keys: string[] }>("SELECT keys FROM ai_settings WHERE id=$1", [owner])).rows[0].keys[0];
    assert.equal(openSecret(replacement, secretContext(owner, "gemini")), "synthetic-new-gemini-key");
    await f.pg.query("UPDATE ai_settings SET keys=$2::jsonb WHERE id=$1", [owner, JSON.stringify([broken, replacement])]);
    assert.equal((await post(POST, { removeIndex: [0] })).status, 200);
    assert.deepEqual((await f.pg.query("SELECT keys FROM ai_settings WHERE id=$1", [owner])).rows, [{ keys: [replacement] }]);
    clearKeyring();
    await f.pg.query("UPDATE ai_settings SET keys=$2::jsonb WHERE id=$1", [owner, JSON.stringify([broken])]);
    const cleared = await post(POST, { clearKeys: true });
    assert.equal(cleared.status, 200);
    assert.deepEqual((await cleared.json()).keysMasked, []);
    assert.deepEqual((await f.pg.query("SELECT keys FROM ai_settings WHERE id=$1", [owner])).rows, [{ keys: [] }]);
  } finally { clearKeyring(); await f.close(); }
});

test("the separate narrative verification credential stays editable when its old value cannot be read", async () => {
  const f = await accountsDb();
  installKeyring();
  process.env.NARRATIVE_ADMIN_OPENROUTER_API_KEY = "synthetic-administrator-verification-key";
  try {
    const narrative = await import("../src/app/api/settings/narrative/route");
    const { getNarrativeGuardConfig } = await import("../src/lib/narrative-settings");
    await f.pg.query("INSERT INTO ai_settings(id,narrative_guard_key,narrative_guard_provider) VALUES ($1,$2,'typesafe')", [owner, broken]);
    const loaded = await cookieContext(cookie, () => narrative.GET());
    assert.equal(loaded.status, 200);
    const view = await loaded.json();
    assert.equal(view.credentialIssue, true);
    assert.equal(view.active, false);
    assert.equal(view.configured, true);
    assert.equal(view.maskedKey, "••••");
    assert.equal(view.administratorAvailable, true);
    assert.equal(view.credentialSource, "personal");
    assert.equal(view.provider, "typesafe");
    assert.equal(view.model, "jev-1.13.0");
    await assert.rejects(() => getNarrativeGuardConfig(owner), { code: "SECRET_DECRYPTION_FAILED" });
    assert.equal((await post(narrative.POST, { enabled: false })).status, 200);
    assert.equal((await f.pg.query<{ narrative_guard_key: string }>("SELECT narrative_guard_key FROM ai_settings WHERE id=$1", [owner])).rows[0].narrative_guard_key, broken);
    const replaced = await post(narrative.POST, { key: "synthetic-new-verification-key", enabled: true });
    assert.equal(replaced.status, 200);
    assert.equal((await replaced.json()).active, true);
    const row = (await f.pg.query<{ narrative_guard_key: string }>("SELECT narrative_guard_key FROM ai_settings WHERE id=$1", [owner])).rows[0];
    assert.equal(openSecret(row.narrative_guard_key, secretContext(owner, "narrative:typesafe")), "synthetic-new-verification-key");
    clearKeyring();
    await f.pg.query("UPDATE ai_settings SET narrative_guard_key=$2 WHERE id=$1", [owner, broken]);
    assert.equal((await post(narrative.POST, { clearKey: true })).status, 200);
  } finally { delete process.env.NARRATIVE_ADMIN_OPENROUTER_API_KEY; clearKeyring(); await f.close(); }
});
