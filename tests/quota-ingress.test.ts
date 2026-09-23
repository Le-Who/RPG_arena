import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { sealSecret, secretContext } from "../src/lib/secret-vault";
import { profileIdFromToken } from "../src/lib/guest-identity";
import { quotaUsage, reserveModelCall } from "../src/lib/quota";

test("personal settings, draft retries and connection tests share the effective owner's app budgets", async () => {
  const f = await accountsDb(); const old = global.fetch;
  process.env.CHRONICLE_SECRET_ACTIVE_KEY = "quota-test";
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ "quota-test": Buffer.alloc(32, 7).toString("base64") });
  const guest = "9".repeat(64), owner = profileIdFromToken(guest)!;
  try {
    const { POST: settings, GET: readSettings } = await import("../src/app/api/settings/route");
    const { POST: connection } = await import("../src/app/api/settings/test/route");
    const { POST: draft } = await import("../src/app/api/story-drafts/autofill/route");
    const { GET: stats } = await import("../src/app/api/tokens/stats/route");
    let calls = 0;
    global.fetch = async url => {
      calls++;
      return String(url).includes("embedContent") ? Response.json({ embedding: { values: Array.from({ length: 128 }, (_, i) => i === 0 ? 1 : 0) } }) : Response.json({ candidates: [{ content: { parts: [{ text: "invalid json" }] }, finishReason: "STOP" }] });
    };
    await cookieContext(`chronicle_guest=${guest}`, async () => {
      let response = await settings(new Request("https://game.test/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keysText: "synthetic-key-one synthetic-key-two", useLiveAI: true, dailyLiteLimit: 1, dailyEmbeddingLimit: 1, embeddingDims: 128 }) }));
      assert.equal(response.status, 200);
      let config = await response.json(); assert.equal(config.keysSharedProject, true); assert.equal(config.dailyEmbeddingLimit, 1);
      const fields = ["title", "worldName", "pitch", "era", "tone", "mainQuest", "startLocation", "name", "archetype", "backstory", "skills", "startItems"];
      response = await draft(new Request("https://game.test/api/story-drafts/autofill", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ draft: { ...Object.fromEntries(fields.map(k => [k, ""])), rulesProfile: "narrative" } }) }));
      assert.equal(response.status, 429); assert.equal(calls, 1, "validation retry cannot send another fetch at cap1");
      assert.equal((await quotaUsage(owner))["gemini-3.5-flash-lite"], 1);
      assert.equal((await connection()).status, 200);
      assert.equal((await connection()).status, 502);
      assert.equal(calls, 2, "denied embedding connection test sends no fetch");
      const statistics = await (await stats()).json();
      assert.equal(statistics.quotas.embeddingAttempts["gemini-embedding-2"], 1);
      assert.equal(statistics.quotas.keysSharedProject, true);
      assert.equal(statistics.today.liteCap, 1);
      response = await settings(new Request("https://game.test/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keysSharedProject: false, dailyEmbeddingLimit: 1e30 }) }));
      config = await response.json(); assert.equal(config.dailyEmbeddingLimit, 1000000); assert.equal(config.keysSharedProject, false);
      assert.equal((await (await readSettings()).json()).keysSharedProject, false);
    });
    const { auth } = await import("../src/lib/auth");
    const account = await auth.register(guest, "quota-player", "correct horse battery staple");
    assert.equal(account.identity.profileId, owner);
    assert.equal(await reserveModelCall({ ownerId: account.identity.profileId, scope: "generation", model: "gemini-3.5-flash-lite", cap: 1 }), false, "registration cannot reset same-profile budget");
  } finally { global.fetch = old; delete process.env.CHRONICLE_SECRET_KEYS; delete process.env.CHRONICLE_SECRET_ACTIVE_KEY; await f.close(); }
});

test("embedding batches, prewarm, cache misses and indexing all reserve before HTTP", async () => {
  const f = await accountsDb(); const old = global.fetch;
  process.env.CHRONICLE_SECRET_ACTIVE_KEY = "quota-test";
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ "quota-test": Buffer.alloc(32, 7).toString("base64") });
  try {
    const { embedTexts, enqueueEmbeddings, indexPendingEmbeddings, searchMemory, backfillSession } = await import("../src/lib/embeddings");
    const { prewarmSessionChoices, buildMemoryQuery } = await import("../src/lib/choice-prewarm");
    const owner = "embedding-owner", sessionId = randomUUID(), model = "gemini-embedding-2", keys = ["synthetic-one", "synthetic-two"];
    await f.pg.query("INSERT INTO ai_settings(id,keys,use_live_ai,embedding_dims,daily_embedding_limit) VALUES ($1,$2,true,128,1)", [owner, JSON.stringify(keys.map(k => sealSecret(k, secretContext(owner, "gemini"))))]);
    await f.pg.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,$2,'quota','{}',$3)", [sessionId, owner, JSON.stringify({ currentLocation: "Harbor" })]);
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const id = randomUUID(); ids.push(id);
      await f.pg.query("INSERT INTO memory_nodes(id,session_id,layer,category,title,content) VALUES ($1,$2,'semantic','event',$3,'A remembered event')", [id, sessionId, `Memory ${i}`]);
    }
    let calls = 0;
    global.fetch = async (_, init) => {
      calls++;
      const body = JSON.parse(String(init?.body)), vector = Array.from({ length: 128 }, (_, i) => i === 0 ? 1 : 0);
      return Response.json(body.requests ? { embeddings: body.requests.map(() => ({ values: vector })) } : { embedding: { values: vector } });
    };
    await enqueueEmbeddings(sessionId, ids, model, 128);
    assert.equal((await indexPendingEmbeddings({ sessionId, keys, model, dims: 128 })).indexed, 7);
    assert.equal(calls, 1, "seven documents in one batch count one attempt");
    await assert.rejects(() => embedTexts({ sessionId, keys, model, dims: 128, texts: ["query"] }), /QUOTA_EXHAUSTED/);
    await assert.rejects(() => searchMemory({ sessionId, keys, model, dims: 128, query: "uncached" }), /QUOTA_EXHAUSTED/);
    await f.pg.query("INSERT INTO game_turns(session_id,turn_number,role,content,choices) VALUES ($1,1,'narrator','Look around',$2)", [sessionId, JSON.stringify(["Go north", "Go south"])]);
    await prewarmSessionChoices(sessionId);
    assert.equal(calls, 1);
    await f.pg.query("UPDATE ai_settings SET daily_embedding_limit=2 WHERE id=$1", [owner]);
    await prewarmSessionChoices(sessionId);
    assert.equal(calls, 2);
    const result = await searchMemory({ sessionId, keys, model, dims: 128, query: buildMemoryQuery("Go north", "Harbor", "Look around") });
    assert.ok(result.results.length > 0); assert.equal(calls, 2, "prewarmed cache hit makes no new reservation");
    await f.pg.query("UPDATE memory_nodes SET content='Changed document' WHERE id=$1", [ids[0]]);
    await backfillSession(sessionId, model, 128);
    assert.equal((await indexPendingEmbeddings({ sessionId, keys, model, dims: 128 })).indexed, 0);
    const pending = (await f.pg.query<{ attempts: number; status: string }>("SELECT attempts,status FROM memory_embeddings WHERE memory_node_id=$1", [ids[0]])).rows[0];
    assert.equal(pending.status, "pending"); assert.equal(pending.attempts, 0, "quota denial must not spend a job's provider retry budget");
    assert.equal(calls, 2);
    assert.equal((await quotaUsage(owner, "embedding"))[model], 2);
    // A real failed HTTP attempt is ambiguous and must not be refunded or turned into zero-fetch deferral.
    await f.pg.query("UPDATE ai_settings SET daily_embedding_limit=3 WHERE id=$1", [owner]);
    await f.pg.query("UPDATE memory_embeddings SET next_attempt_at=now() WHERE memory_node_id=$1", [ids[0]]);
    global.fetch = async () => { calls++; return new Response("", { status: 503 }); };
    await indexPendingEmbeddings({ sessionId, keys, model, dims: 128 });
    assert.equal(calls, 3, "next key is denied after the failed first key consumes remaining capacity");
    assert.equal((await f.pg.query<{ attempts: number }>("SELECT attempts FROM memory_embeddings WHERE memory_node_id=$1", [ids[0]])).rows[0].attempts, 1);
    assert.equal((await quotaUsage(owner, "embedding"))[model], 3);
  } finally { global.fetch = old; delete process.env.CHRONICLE_SECRET_KEYS; delete process.env.CHRONICLE_SECRET_ACTIVE_KEY; await f.close(); }
});

test("semantic job contention after preflight defers without spending a provider retry", async () => {
  const f = await accountsDb(); const old = global.fetch;
  try {
    const { processSemanticJob } = await import("../src/lib/memory-jobs");
    const { getAIConfig } = await import("../src/lib/ai-settings");
    const { pool } = await import("../src/db");
    const owner = "semantic-owner", sessionId = randomUUID();
    await f.pg.query("INSERT INTO ai_settings(id,daily_lite_limit) VALUES ($1,1)", [owner]);
    const cfg = { ...await getAIConfig(owner), keys: ["synthetic"], canUseLive: true, limits: { lite: 1, flash: 0 } };
    await f.pg.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,$2,'quota','{}','{}')", [sessionId, owner]);
    await f.pg.query("INSERT INTO memory_jobs(session_id,turn_number,kind,payload) VALUES ($1,1,'semantic',$2)", [sessionId, JSON.stringify({ narration: "A gate opened", playerAction: "Open gate", profileCanon: "narrative", knownDigest: "" })]);
    let calls = 0; global.fetch = async () => { calls++; throw new Error("Unexpected provider fetch"); };
    // A competing request wins immediately after the advisory preflight read.
    let raced = false;
    const query = mock.method(pool, "query", (async (...args: Parameters<typeof f.run>) => {
      const result = await f.run(...args);
      if (!raced && (typeof args[0] === "string" ? args[0] : args[0].text).includes("WITH legacy AS")) {
        raced = true;
        await reserveModelCall({ ownerId: owner, scope: "generation", model: "gemini-3.5-flash-lite", cap: 1 });
      }
      return result;
    }) as never);
    try {
      const result = await processSemanticJob({ sessionId, cfg });
      assert.equal(result.delayed, true); assert.equal(result.failed, 0); assert.equal(calls, 0);
      const job = (await f.pg.query<{ status: string; attempts: number; lease_token: string | null }>("SELECT status,attempts,lease_token FROM memory_jobs WHERE session_id=$1", [sessionId])).rows[0];
      assert.deepEqual(job, { status: "pending", attempts: 0, lease_token: null });
    } finally { query.mock.restore(); }
  } finally { global.fetch = old; await f.close(); }
});

test("compaction reserves each HTTP attempt and exhausted quotas retain exact excerpts", async () => {
  const f = await accountsDb(); const old = global.fetch;
  process.env.CHRONICLE_SECRET_ACTIVE_KEY = "quota-test";
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ "quota-test": Buffer.alloc(32, 7).toString("base64") });
  try {
    const { compactSession } = await import("../src/lib/compaction");
    const sessionId = randomUUID(), owner = "compaction-owner";
    await f.pg.query("INSERT INTO ai_settings(id,keys,use_live_ai,daily_flash_limit,daily_lite_limit) VALUES ($1,$2,true,1,0)", [owner, JSON.stringify([sealSecret("synthetic", secretContext(owner, "gemini"))])]);
    await f.pg.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state,turn_count) VALUES ($1,$2,'quota','{}','{}',1)", [sessionId, owner]);
    await f.pg.query("INSERT INTO game_turns(session_id,turn_number,role,content) VALUES ($1,1,'narrator','A gate opened, and the traveler entered the harbor.')", [sessionId]);
    let calls = 0;
    global.fetch = async () => { calls++; return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ summaries: [{ turnNumber: 1, summary: "The traveler entered the harbor after a gate opened.", evidence: "A gate opened" }] }) }] }, finishReason: "STOP" }] }); };
    assert.equal((await compactSession(sessionId)).mode, "verified-summaries-and-excerpts");
    assert.equal(calls, 1); assert.equal((await quotaUsage(owner))["gemini-3.8-flash"], 1);
    // Exhaust every configured fallback before the next compaction window.
    await f.pg.query("UPDATE ai_settings SET daily_flash_limit=0 WHERE id=$1", [owner]);
    await f.pg.query("UPDATE game_sessions SET turn_count=2 WHERE id=$1", [sessionId]);
    await f.pg.query("INSERT INTO game_turns(session_id,turn_number,role,content) VALUES ($1,2,'narrator','The traveler rested by the sea.')", [sessionId]);
    assert.equal((await compactSession(sessionId)).mode, "exact-excerpts");
    assert.equal(calls, 1);
  } finally { global.fetch = old; delete process.env.CHRONICLE_SECRET_KEYS; delete process.env.CHRONICLE_SECRET_ACTIVE_KEY; await f.close(); }
});
