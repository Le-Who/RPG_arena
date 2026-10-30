import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { profileIdFromToken } from "../src/lib/guest-identity";
import { openSecret, secretContext, hasStoredSettingsCredentials, rebindSettingsSecrets } from "../src/lib/secret-vault";

test("OpenAI image connection is encrypted, isolated from narrator keys and recoverable without admin", async () => {
  const f = await accountsDb();
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ test: Buffer.alloc(32, 42).toString("base64") });
  process.env.CHRONICLE_SECRET_ACTIVE_KEY = "test";
  try {
    const settings = await import("../src/lib/text-provider-settings");
    const { getRawSettingsRow } = await import("../src/lib/ai-settings");
    const { getVisualPreferences, saveVisualPreferences, visualCredential } = await import("../src/lib/visual-settings");
    await settings.saveProviderConnection("openai-owner", { provider: "gemini", apiKey: "synthetic-gemini" });
    const before = await getRawSettingsRow("openai-owner");
    const result = await settings.saveProviderConnection("openai-owner", { provider: "openai", apiKey: "synthetic-openai" });
    assert.equal(result.openaiConfigured, true);
    assert.doesNotMatch(JSON.stringify(result), /synthetic|enc:v1/);
    const row = await getRawSettingsRow("openai-owner");
    assert.deepEqual(row.keys, before.keys);
    assert.equal(row.textProvider, before.textProvider);
    assert.equal(row.useLiveAI, before.useLiveAI);
    assert.equal(openSecret(row.openaiKey, secretContext(row.id, "visual:openai")), "synthetic-openai");
    assert.equal(hasStoredSettingsCredentials({ openaiKey: row.openaiKey }), true);
    const rebound = rebindSettingsSecrets(row, "new-owner");
    assert.equal(openSecret(rebound.openaiKey!, secretContext("new-owner", "visual:openai")), "synthetic-openai");
    assert.throws(() => openSecret(rebound.openaiKey!, secretContext(row.id, "visual:openai")));
    assert.equal((await settings.getProviderConnections("other-owner")).openaiConfigured, false);
    await saveVisualPreferences(row.id, { enabled: true, provider: "openai", model: "gpt-image-2.5-flare", accountSource: "personal", endpoint: null });
    assert.equal((await getVisualPreferences(row.id)).openaiConfigured, true);
    await assert.rejects(saveVisualPreferences(row.id, { provider: "openai", model: "gpt-image-2.5-flare", accountSource: "application" }));
    await assert.rejects(saveVisualPreferences(row.id, { provider: "openai", model: "gpt-image-2.5-flare", accountSource: "personal", endpoint: "stale-router" }));
    await assert.rejects(saveVisualPreferences(row.id, { provider: "openai", model: "gpt-text-fiction", accountSource: "personal" }));
    await assert.rejects(visualCredential(row.id, "application", "openai"));
    assert.throws(() => settings.parseTextProviderSettings({ provider: "openai", model: "gpt-image-2.5-flare" }));
    await f.pg.query("UPDATE ai_settings SET openai_key='enc:v1:missing:broken' WHERE id=$1", [row.id]);
    assert.deepEqual((await settings.getProviderConnections(row.id)).credentialIssues, ["openai"]);
    await settings.saveProviderConnection(row.id, { provider: "openai", clearKey: true });
    assert.equal((await settings.getProviderConnections(row.id)).openaiConfigured, false);
    assert.equal((await getVisualPreferences(row.id)).provider, "openai");
    await assert.rejects(visualCredential(row.id, "personal", "openai"));
  } finally { delete process.env.CHRONICLE_SECRET_KEYS; delete process.env.CHRONICLE_SECRET_ACTIVE_KEY; await f.close(); }
});

test("OpenAI image snapshot keeps its model and payer on retry; removed keys never fall back", async () => {
  const f = await accountsDb(), oldFetch = global.fetch;
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ test: Buffer.alloc(32, 42).toString("base64") });
  process.env.CHRONICLE_SECRET_ACTIVE_KEY = "test";
  process.env.OPENAI_API_KEY = "synthetic-env-must-not-be-used";
  const requests: Record<string, unknown>[] = [];
  let fail = true;
  global.fetch = async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/images/generations");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-openai");
    requests.push(JSON.parse(String(init?.body)));
    if (fail) return new Response("sensitive-body", { status: 401 });
    return Response.json({ data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==" }] });
  };
  try {
    const { saveProviderConnection } = await import("../src/lib/text-provider-settings");
    const { saveVisualPreferences } = await import("../src/lib/visual-settings");
    const { createVisual, renderVisual, listVisuals } = await import("../src/lib/visuals");
    await saveProviderConnection("image-owner", { provider: "openai", apiKey: "synthetic-openai" });
    await saveVisualPreferences("image-owner", { provider: "openai", model: "gpt-image-2.5-flare", accountSource: "personal" });
    const session = randomUUID();
    await f.pg.query(`INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,'image-owner','Fixture','{"name":"Анна"}','{"currentLocation":"Кафе"}')`, [session]);
    const visual = await createVisual(session, { kind: "portrait", subject: "hero" });
    assert.equal(visual.provider, "openai");
    assert.equal(visual.outputFormat, "png");
    assert.equal(visual.width, 1024);
    assert.equal(visual.height, 1536);
    await assert.rejects(renderVisual(session, visual.id));
    assert.match((await listVisuals(session)).visuals[0].error!, /OpenAI отклонил API-ключ/);
    assert.equal((await f.pg.query<{ error: string }>("SELECT error FROM scene_visuals WHERE id=$1", [visual.id])).rows[0].error, "OPENAI_AUTH_FAILED");
    await saveVisualPreferences("image-owner", { enabled: false, provider: "pollinations", model: "fixture/new", accountSource: "application" });
    await saveProviderConnection("image-owner", { provider: "openai", clearKey: true });
    await assert.rejects(renderVisual(session, visual.id, { retry: true }));
    assert.equal(requests.length, 1);
    await saveProviderConnection("image-owner", { provider: "openai", apiKey: "synthetic-openai" });
    fail = false;
    const image = await renderVisual(session, visual.id, { retry: true });
    assert.equal(image.mimeType, "image/png");
    assert.equal(requests[1].model, "gpt-image-2.5-flare");
    assert.equal(requests[1].size, "1024x1536");
    await f.pg.query("UPDATE scene_visuals SET status='failed',image=null,mime_type=null WHERE id=$1", [visual.id]);
    await f.pg.query("UPDATE game_sessions SET owner_id='new-owner' WHERE id=$1", [session]);
    await assert.rejects(renderVisual(session, visual.id, { retry: true }), error => (error as { code?: string }).code === "VISUAL_PAYER_CHANGED");
    assert.equal(requests.length, 2);
    await assert.rejects(f.pg.query("UPDATE ai_settings SET visual_provider='openai',visual_account_source='application' WHERE id='image-owner'"), /check constraint/i);
    await assert.rejects(f.pg.query("UPDATE scene_visuals SET account_source='application' WHERE id=$1", [visual.id]), /check constraint/i);
  } finally { global.fetch = oldFetch; delete process.env.CHRONICLE_SECRET_KEYS; delete process.env.CHRONICLE_SECRET_ACTIVE_KEY; delete process.env.OPENAI_API_KEY; await f.close(); }
});

test("OpenAI catalog requires identity and never makes a paid request", async () => {
  const f = await accountsDb(), oldFetch = global.fetch;
  global.fetch = async () => { throw new Error("catalog must be local"); };
  try {
    const { GET } = await import("../src/app/api/settings/visual-provider/models/route");
    const token = "a".repeat(64);
    const owner = profileIdFromToken(token);
    assert.ok(owner);
    const response = await cookieContext(`chronicle_guest=${token}`, () => GET(new Request("http://local/api/settings/visual-provider/models?provider=openai")));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const body = await response.json();
    assert.ok(body.models.some((model: { id: string }) => model.id === "gpt-image-2.5-flare"));
  } finally { global.fetch = oldFetch; await f.close(); }
});

test("OpenAI keeps a live two-minute lease instead of charging a second generation", async () => {
  const f = await accountsDb(), oldFetch = global.fetch;
  const session = randomUUID(), visual = randomUUID(), now = Date.now();
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error("must not spend while another generation is active"); };
  try {
    await f.pg.query(`INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,'slow-owner','Fixture','{}','{}')`, [session]);
    await f.pg.query(`INSERT INTO scene_visuals(id,session_id,owner_id,kind,prompt,provider,account_source,model,seed,width,height,attempts,updated_at)
      VALUES ($1,$2,'slow-owner','portrait','Tea','openai','personal','gpt-image-2.5-flare',1,1024,1536,1,$3)`, [visual, session, new Date(now - 120_000)]);
    const { renderVisual } = await import("../src/lib/visuals");
    // A different worker finishes the original paid attempt while this caller waits.
    // Capture rejection immediately so the old 105s lease fails without unhandled promises.
    const pending = renderVisual(session, visual).then(value => ({ value }), error => ({ error }));
    await new Promise(resolve => setTimeout(resolve, 250));
    await f.pg.query("UPDATE scene_visuals SET status='ready',image=$2,mime_type='image/png' WHERE id=$1", [visual, Buffer.from("synthetic-completed-image")]);
    const result = await pending;
    assert.ok("value" in result, "an active OpenAI attempt must be awaited, never reclaimed");
    assert.equal(Buffer.from(result.value.image).toString(), "synthetic-completed-image");
    assert.equal(calls, 0);
    assert.equal((await f.pg.query<{ attempts: number }>("SELECT attempts FROM scene_visuals WHERE id=$1", [visual])).rows[0].attempts, 1);
  } finally { global.fetch = oldFetch; await f.close(); }
});
