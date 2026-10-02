// Explicit opt-in only: never loaded by npm test, never reads .env.
import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { cookieContext } from "../helpers/accounts-db";

test("PostgreSQL independent-connection auth claims and ownership fencing", { skip: process.env.CHRONICLE_RUN_AUTH_POSTGRES !== "1", timeout: 30000 }, async () => {
  const url = new URL("postgresql://chronicle_test@127.0.0.1:55439/chronicle_auth_test");
  const schema = `auth_task2_${randomUUID().replaceAll("-", "")}`;
  const bootstrap = new Pool({ connectionString: url.toString() });
  await bootstrap.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set("options", `-csearch_path=${schema},public`);
  process.env.DATABASE_URL = url.toString();
  const { pool } = await import("../../src/db");
  try {
    // No vector extension in portable server; exercise all relational schema, not vector readiness.
    for (const file of (await readdir("drizzle")).filter(x => /^\d{4}_.*\.sql$/.test(x) && !x.startsWith("0006_")).sort()) await pool.query((await readFile(`drizzle/${file}`, "utf8")).replaceAll('"public".', `"${schema}".`));
    const { auth } = await import("../../src/lib/auth");
    const { profileIdFromToken } = await import("../../src/lib/guest-identity");
    const { withOwnerWork, withCampaignOwnerWork } = await import("../../src/lib/owner-work");
    const g = "a".repeat(64);
    const claims = await Promise.allSettled([auth.register(g, "alice", "correct horse battery staple"), auth.register(g, "bob", "correct horse battery staple")]);
    assert.equal(claims.filter(x => x.status === "fulfilled").length, 1);
    const account = (claims.find(x => x.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof auth.register>>>).value;
    const second = await auth.register("b".repeat(64), "carol", "correct horse battery staple");
    const guest = "c".repeat(64), owner = profileIdFromToken(guest)!;
    const sessionId = randomUUID();
    await pool.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,$2,'test','{}','{}')", [sessionId, owner]);
    const { PATCH } = await import("../../src/app/api/sessions/[id]/route");
    let bodyEntered!: () => void, sendBody!: () => void;
    const readingBody = new Promise<void>(r => { bodyEntered = r; });
    const bodyReady = new Promise<void>(r => { sendBody = r; });
    const body = new ReadableStream<Uint8Array>({ async pull(controller) { bodyEntered(); await bodyReady; controller.enqueue(new TextEncoder().encode('{"title":"kept-safe"}')); controller.close(); } }, { highWaterMark: 0 });
    const patchRequest = new Request(`https://game.test/api/sessions/${sessionId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body, duplex: "half" } as RequestInit);
    const patch = cookieContext(`chronicle_guest=${guest}`, () => PATCH(patchRequest, { params: Promise.resolve({ id: sessionId }) }));
    await readingBody;
    try { await assert.rejects(() => auth.adopt(guest, account.sessionToken), /OWNER_BUSY/); }
    finally { sendBody(); await patch; }
    assert.equal((await pool.query("SELECT title FROM game_sessions WHERE id=$1", [sessionId])).rows[0].title, "kept-safe");
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(r => { entered = r; });
    const hold = new Promise<void>(r => { release = r; });
    const active = withCampaignOwnerWork(sessionId, owner, async () => { entered(); await hold; });
    await ready;
    try {
      assert.equal(Number((await pool.query("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=9143 AND granted")).rows[0].count), 0, "provider work must retain neither session advisory locks nor open xact locks (transaction-pooler safe)");
      await assert.rejects(() => auth.adopt(guest, account.sessionToken), /OWNER_BUSY/);
    } finally { release(); await active; }
    const adoption = await Promise.allSettled([auth.adopt(guest, account.sessionToken), auth.adopt(guest, second.sessionToken)]);
    assert.equal(adoption.filter(x => x.status === "fulfilled").length, 1);
    await assert.rejects(() => auth.resolve(guest), /IDENTITY_REQUIRED/);
    let executed = false;
    await assert.rejects(() => withCampaignOwnerWork(sessionId, owner, async () => { executed = true; }), /OWNER_CHANGED/);
    assert.equal(executed, false, "captured old-owner config must not reach a provider callback");
    const { acquireTurn } = await import("../../src/lib/turn-admission");
    await assert.rejects(() => acquireTurn({ sessionId, expectedOwnerId: owner, action: "wait", isFree: true, requestId: "stale-authorized" }), /NOT_FOUND/);
    assert.equal(Number((await pool.query("SELECT count(*) FROM turn_requests")).rows[0].count), 0);
    // More simultaneous guards than main-pool capacity, each needing more SQL.
    await Promise.all(Array.from({ length: 16 }, (_, i) => withOwnerWork(`nested-${i}`, async () => {
      await withOwnerWork(`nested-${i}`, async () => { await pool.query("SELECT 1"); });
    })));
    // A nested streamed operation outlives its HTTP wrapper; activity must stay registered.
    const streamGuest = "d".repeat(64), streamOwner = profileIdFromToken(streamGuest)!;
    let finish!: () => void;
    const streamHold = new Promise<void>(r => { finish = r; });
    let child: Promise<void> | undefined;
    await withOwnerWork(streamOwner, async () => { child = withOwnerWork(streamOwner, async () => { await streamHold; }); });
    await assert.rejects(() => auth.register(streamGuest, "streaming", "correct horse battery staple"), /OWNER_BUSY/);
    finish(); await child;
    await auth.register(streamGuest, "streaming", "correct horse battery staple");
    // Creation cannot strand a new campaign behind a guest credential claimed mid-request.
    const { POST: createCampaign } = await import("../../src/app/api/sessions/route");
    const creationGuest = "e".repeat(64), creationOwner = profileIdFromToken(creationGuest)!;
    let creationReading!: () => void, sendCreation!: () => void;
    const creationStarted = new Promise<void>(r => { creationReading = r; });
    const creationReady = new Promise<void>(r => { sendCreation = r; });
    const creationBody = new ReadableStream<Uint8Array>({ async pull(controller) { creationReading(); await creationReady; controller.enqueue(new TextEncoder().encode('{"mode":"free","customScenario":{"title":"Race-safe campaign"}}')); controller.close(); } }, { highWaterMark: 0 });
    const afterJobs: (() => Promise<void>)[] = [];
    const creation = cookieContext(`chronicle_guest=${creationGuest}`, () => createCampaign(new Request("https://game.test/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: creationBody, duplex: "half" } as RequestInit)), afterJobs);
    await creationStarted;
    try { await assert.rejects(() => auth.register(creationGuest, "creator", "correct horse battery staple"), /OWNER_BUSY/); }
    finally { sendCreation(); }
    const created = await creation;
    assert.equal(created.status, 200);
    const createdSession = (await created.json()).session.id;
    const creator = await auth.register(creationGuest, "creator", "correct horse battery staple");
    assert.equal((await pool.query("SELECT owner_id FROM game_sessions WHERE id=$1", [createdSession])).rows[0].owner_id, creator.identity.profileId);
    assert.equal(creator.identity.profileId, creationOwner);
    for (const job of afterJobs) await job();
    const stalePatch = await cookieContext(`chronicle_guest=${creationGuest}`, () => PATCH(new Request("https://game.test", { method: "PATCH", headers: { "content-type": "application/json" }, body: '{"title":"stolen"}' }), { params: Promise.resolve({ id: createdSession }) }));
    assert.equal(stalePatch.status, 401);
    assert.equal((await pool.query("SELECT title FROM game_sessions WHERE id=$1", [createdSession])).rows[0].title, "Race-safe campaign");
    // Real worker path holds durable activity until its provider and canonical write finish.
    const workerGuest = "f".repeat(64), workerOwner = profileIdFromToken(workerGuest)!, workerSession = randomUUID();
    const { sealSecret, secretContext } = await import("../../src/lib/secret-vault");
    const ring = { active: "concurrency-test", keys: { "concurrency-test": Buffer.alloc(32, 4).toString("base64") } };
    process.env.CHRONICLE_SECRET_ACTIVE_KEY = ring.active;
    process.env.CHRONICLE_SECRET_KEYS = JSON.stringify(ring.keys);
    await pool.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,$2,'worker','{}','{}')", [workerSession, workerOwner]);
    await pool.query("INSERT INTO ai_settings(id,keys,use_live_ai,embeddings_enabled) VALUES ($1,$2,true,false)", [workerOwner, JSON.stringify([sealSecret("synthetic-gemini", secretContext(workerOwner, "gemini"), ring)])]);
    await pool.query("INSERT INTO memory_jobs(session_id,turn_number,kind,payload) VALUES ($1,1,'semantic',$2)", [workerSession, JSON.stringify({ narration: "Страж открыл ворота.", playerAction: "Открыть ворота", profileCanon: "narrative", knownDigest: "" })]);
    const { runMemoryCycle } = await import("../../src/lib/background");
    const originalFetch = globalThis.fetch;
    let providerEntered!: () => void, finishProvider!: () => void;
    const providerStarted = new Promise<void>(r => { providerEntered = r; });
    const providerReady = new Promise<void>(r => { finishProvider = r; });
    let providerCalls = 0;
    globalThis.fetch = async url => {
      assert.ok(String(url).startsWith("https://generativelanguage.googleapis.com/"));
      providerCalls++; providerEntered(); await providerReady;
      return Response.json({ candidates: [{ content: { parts: [{ text: '{"facts":[]}' }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
    };
    try {
      const worker = runMemoryCycle({ sessionId: workerSession, ownerId: workerOwner, source: "worker" });
      await providerStarted;
      try { await assert.rejects(() => auth.adopt(workerGuest, account.sessionToken), /OWNER_BUSY/); }
      finally { finishProvider(); }
      assert.equal((await worker).processed, 1);
      await auth.adopt(workerGuest, account.sessionToken);
      await assert.rejects(() => runMemoryCycle({ sessionId: workerSession, ownerId: workerOwner, source: "worker" }), /owner mismatch/);
      assert.equal(providerCalls, 1);
      assert.equal((await pool.query("SELECT owner_id FROM token_logs WHERE session_id=$1", [workerSession])).rows[0].owner_id, workerOwner);
    } finally { globalThis.fetch = originalFetch; delete process.env.CHRONICLE_SECRET_ACTIVE_KEY; delete process.env.CHRONICLE_SECRET_KEYS; }
    assert.equal(Number((await pool.query("SELECT count(*) FROM owner_activity")).rows[0].count), 0);
  } finally {
    await pool.end();
    await bootstrap.query(`DROP SCHEMA ${schema} CASCADE`);
    await bootstrap.end();
  }
});
