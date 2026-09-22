import test from "node:test";
import assert from "node:assert/strict";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { auth } from "../src/lib/auth";
import { randomUUID } from "node:crypto";
import { sealSecret, secretContext } from "../src/lib/secret-vault";

test("direct system/developer handlers deny guest and normal account before diagnostics or malformed-body effects", async () => {
  const f = await accountsDb();
  try {
    const guest = "c".repeat(64);
    const { GET: system } = await import("../src/app/api/system/status/route");
    const { POST: process } = await import("../src/app/api/system/process/route");
    const dev = await import("../src/app/api/developer/typesafe/route");
    const { POST: probe } = await import("../src/app/api/developer/typesafe/test/route");
    const { GET: results } = await import("../src/app/api/developer/typesafe/results/route");
    const a = await auth.register(guest, "ordinary", "correct horse battery staple");
    for (const cookie of [`chronicle_guest=${"d".repeat(64)}`, `chronicle_guest=${a.guestToken}; chronicle_session=${a.sessionToken}`]) {
      await cookieContext(cookie, async () => {
        for (const invoke of [system, results, probe, dev.GET,
          () => process(new Request("https://game.test/api/system/process", { method: "POST", body: "not-json" })),
          () => dev.POST(new Request("https://game.test/api/developer/typesafe", { method: "POST", body: "not-json" }))]) {
          assert.equal((await invoke()).status, 403);
        }
      });
    }
    assert.equal((await f.pg.query<{ n: number }>("SELECT count(*)::int n FROM ai_settings")).rows[0].n, 0);
    assert.equal((await f.pg.query<{ n: number }>("SELECT count(*)::int n FROM token_logs")).rows[0].n, 0);
  } finally { await f.close(); }
});

test("admin role preserves ownership on diagnostics and personal settings remain usable by guests", async () => {
  const f = await accountsDb();
  try {
    const guest = "f".repeat(64);
    const a = await auth.register(guest, "administrator", "correct horse battery staple");
    const own = randomUUID(), other = randomUUID();
    await f.pg.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,$2,'own','{}','{}'),($3,'other-owner','other','{}','{}')", [own, a.identity.profileId, other]);
    const { GET: diagnostics } = await import("../src/app/api/sessions/[id]/narrative-diagnostics/route");
    const { GET: personal } = await import("../src/app/api/settings/route");
    const { POST: personalProbe } = await import("../src/app/api/settings/test/route");
    const systemPage = (await import("../src/app/system/page")).default;
    await cookieContext(`chronicle_guest=${a.guestToken}`, async () => {
      assert.equal((await personal()).status, 200);
      assert.equal((await personalProbe()).status, 409, "guest reaches personal BYOK no-key result, not admin denial");
      assert.equal((await diagnostics(new Request("https://game.test"), { params: Promise.resolve({ id: own }) })).status, 403);
      await assert.rejects(systemPage, /NEXT_HTTP_ERROR_FALLBACK;404/);
    });
    process.env.CHRONICLE_ADMIN_ACCOUNT_IDS = a.identity.account!.id;
    await cookieContext(`chronicle_guest=${a.guestToken}; chronicle_session=${a.sessionToken}`, async () => {
      assert.equal((await diagnostics(new Request("https://game.test"), { params: Promise.resolve({ id: own }) })).status, 200);
      assert.equal((await diagnostics(new Request("https://game.test"), { params: Promise.resolve({ id: other }) })).status, 404);
      delete process.env.CHRONICLE_ADMIN_ACCOUNT_IDS;
      assert.equal((await diagnostics(new Request("https://game.test"), { params: Promise.resolve({ id: own }) })).status, 403);
    });
  } finally { delete process.env.CHRONICLE_ADMIN_ACCOUNT_IDS; await f.close(); }
});

test("real worker extraction never invokes old enabled Jev pilot for a non-admin owner", async () => {
  const f = await accountsDb();
  const originalFetch = globalThis.fetch;
  process.env.CHRONICLE_SECRET_ACTIVE_KEY = "worker-test";
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ "worker-test": Buffer.alloc(32, 3).toString("base64") });
  try {
    const a = await auth.register("3".repeat(64), "workerplayer", "correct horse battery staple");
    const owner = a.identity.profileId, session = randomUUID();
    await f.pg.query("INSERT INTO ai_settings(id,keys,use_live_ai,embeddings_enabled,typesafe_key,typesafe_pilot_enabled) VALUES ($1,$2,true,false,$3,true)", [owner, JSON.stringify([sealSecret("fake-gemini", secretContext(owner, "gemini"))]), sealSecret("fake-jev", secretContext(owner, "typesafe-pilot"))]);
    await f.pg.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,$2,'worker','{}','{}')", [session, owner]);
    const narration = "Страж открыл ворота и впустил героя в город.";
    await f.pg.query("INSERT INTO memory_jobs(session_id,turn_number,kind,payload) VALUES ($1,1,'semantic',$2)", [session, JSON.stringify({ narration, playerAction: "Попросить открыть ворота", profileCanon: "narrative", knownDigest: "" })]);
    const urls: string[] = [];
    globalThis.fetch = async url => {
      urls.push(String(url));
      assert.ok(String(url).startsWith("https://generativelanguage.googleapis.com/"), "worker must not contact Jev for this owner");
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ facts: [{ type: "event", entityKey: "gate", title: "Ворота открыты", content: narration, evidence: "Страж открыл ворота", importance: 60, confidence: .95 }] }) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } });
    };
    const { runMemoryCycle } = await import("../src/lib/background");
    const result = await runMemoryCycle({ sessionId: session, ownerId: owner, source: "worker" });
    assert.equal(result.processed, 1, JSON.stringify({ result, urls, jobs: (await f.pg.query("SELECT status,error,attempts FROM memory_jobs")).rows }));
    assert.equal(result.extracted, 1);
    assert.equal(urls.length, 1);
    const jobs = await f.pg.query<{ status: string; typesafe_report: unknown }>("SELECT status,typesafe_report FROM memory_jobs");
    assert.equal(jobs.rows[0].status, "completed");
    assert.equal(jobs.rows[0].typesafe_report, null);
  } finally { globalThis.fetch = originalFetch; delete process.env.CHRONICLE_SECRET_ACTIVE_KEY; delete process.env.CHRONICLE_SECRET_KEYS; await f.close(); }
});

test("worker config ignores old enabled Jev settings for guests/non-admin and rechecks allowlist", async () => {
  const f = await accountsDb();
  try {
    const a = await auth.register("e".repeat(64), "ordinary", "correct horse battery staple");
    await f.pg.query("INSERT INTO ai_settings(id,typesafe_key,typesafe_pilot_enabled) VALUES ($1,'broken-encrypted-secret',true)", [a.identity.profileId]);
    const { getTypeSafePilotConfig } = await import("../src/lib/typesafe-settings");
    assert.deepEqual(await getTypeSafePilotConfig(a.identity.profileId), { enabled: false, apiKey: "", source: "none" });
    process.env.CHRONICLE_ADMIN_ACCOUNT_IDS = a.identity.account!.id;
    // An admin reaches decryption, proving it wasn't a global kill switch.
    await assert.rejects(() => getTypeSafePilotConfig(a.identity.profileId));
    delete process.env.CHRONICLE_ADMIN_ACCOUNT_IDS;
    assert.equal((await getTypeSafePilotConfig(a.identity.profileId)).enabled, false);
  } finally { delete process.env.CHRONICLE_ADMIN_ACCOUNT_IDS; await f.close(); }
});
