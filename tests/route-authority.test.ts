import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { auth } from "../src/lib/auth";
import { profileIdFromToken } from "../src/lib/guest-identity";

const publicId = "10000000-0000-4000-8000-000000000001";
const privateId = "10000000-0000-4000-8000-000000000002";
const readerToken = "c".repeat(64);
const character = { name: "Анна", archetype: "Горожанка", level: 1, xp: 0, hp: 10, maxHp: 10, gold: 5, stats: {}, skills: [], traits: [], conditions: [], backstory: "Живёт у гавани.", appearance: "Серое пальто." };
const world = { worldName: "Гавань", tone: "Спокойный", era: "Сегодня", mainQuest: "Встреча", currentLocation: "Площадь", factions: [], flags: {}, danger: 0, chapter: 1 };

async function handlers() {
  return {
    act: (await import("../src/app/api/sessions/[id]/act/route")).POST,
    poll: (await import("../src/app/api/sessions/[id]/requests/[requestId]/route")).GET,
    turns: (await import("../src/app/api/sessions/[id]/turns/route")).GET,
    checkpoints: await import("../src/app/api/sessions/[id]/checkpoints/route"),
    deleteCheckpoint: (await import("../src/app/api/sessions/[id]/checkpoints/[checkpointId]/route")).DELETE,
    fork: (await import("../src/app/api/sessions/[id]/checkpoints/[checkpointId]/fork/route")).POST,
    copy: (await import("../src/app/api/sessions/[id]/copy/route")).POST,
    memories: (await import("../src/app/api/sessions/[id]/memories/route")).GET,
    search: (await import("../src/app/api/sessions/[id]/memory/search/route")).GET,
    reindex: (await import("../src/app/api/sessions/[id]/memory/reindex/route")).POST,
    export: (await import("../src/app/api/sessions/[id]/export/route")).GET,
  };
}
type Handler = (request: Request, context: { params: Promise<{ id: string; checkpointId: string; requestId: string }> }) => Promise<Response>;

async function fixture() {
  const database = await accountsDb();
  try {
    const owner = await auth.register("a".repeat(64), "routeowner", "correct horse battery staple");
    const admin = await auth.register("b".repeat(64), "routeadmin", "correct horse battery staple");
    process.env.CHRONICLE_ADMIN_ACCOUNT_IDS = admin.identity.account!.id;
    const cookies = {
      owner: `chronicle_guest=${owner.guestToken}; chronicle_session=${owner.sessionToken}`,
      reader: `chronicle_guest=${readerToken}`,
      admin: `chronicle_guest=${admin.guestToken}; chronicle_session=${admin.sessionToken}`,
    };
    for (const [id, visibility, title, content] of [
      [publicId, "public", "Открытая встреча", "Публичная сцена на площади."],
      [privateId, "private", "Личная встреча", "Личная сцена в закрытом саду."],
    ]) {
      await database.pg.query("INSERT INTO game_sessions(id,title,owner_id,visibility,character,world_state,turn_count,campaign_mode,rules_profile) VALUES ($1,$2,$3,$4,$5,$6,1,'preset','narrative')", [id, title, owner.identity.profileId, visibility, JSON.stringify(character), JSON.stringify(world)]);
      await database.pg.query("INSERT INTO world_locations(session_id,name,current) VALUES ($1,'Площадь',true)", [id]);
      await database.pg.query("INSERT INTO game_turns(session_id,turn_number,role,content,created_at,choices) VALUES ($1,1,'player','Я прихожу на встречу.','2026-10-09 10:00:00','[]'),($1,1,'narrator',$2,'2026-10-09 10:00:01','[\"Осмотреть площадь\"]')", [id, content]);
      await database.pg.query("INSERT INTO memory_nodes(session_id,layer,category,title,content,source,source_turn,turn_from,turn_to,tokens_estimate) VALUES ($1,'episodic','event','Встреча',$2,'seed',1,1,1,9)", [id, content]);
      await database.pg.query("INSERT INTO turn_requests(session_id,request_id,input_hash,action,is_free,base_turn,status,stage,error) VALUES ($1,'saved-request','fixture-hash','Старое действие',true,1,'failed','context','AI_REQUIRED')", [id]);
    }
    const route = await handlers();
    const afterJobs: (() => Promise<void>)[] = [];
    const call = (cookie: string, handler: Handler, id: string, method = "GET", path = "", body?: unknown, checkpointId = publicId) => cookieContext(cookie, () => handler(new Request(`https://game.test/api/sessions/${id}/${path}`, {
      method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }), { params: Promise.resolve({ id, checkpointId, requestId: "saved-request" }) }), afterJobs);
    const checkpoints = new Map<string, string>();
    for (const id of [publicId, privateId]) {
      const response = await call(cookies.owner, route.checkpoints.POST, id, "POST", "checkpoints", { title: "До встречи", expectedTurn: 1, requestId: "initial-checkpoint" });
      assert.equal(response.status, 201);
      checkpoints.set(id, (await response.json()).checkpoint.id);
    }
    return { ...database, owner, admin, cookies, route, call, checkpoints, afterJobs, async close() { delete process.env.CHRONICLE_ADMIN_ACCOUNT_IDS; await database.close(); } };
  } catch (error) { delete process.env.CHRONICLE_ADMIN_ACCOUNT_IDS; await database.close(); throw error; }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function counts(f: Fixture) {
  const result = await f.pg.query<Record<string, number>>(`SELECT
    (SELECT count(*)::int FROM game_sessions) AS sessions,
    (SELECT count(*)::int FROM game_turns) AS turns,
    (SELECT count(*)::int FROM turn_requests) AS requests,
    (SELECT count(*)::int FROM campaign_checkpoints) AS checkpoints,
    (SELECT count(*)::int FROM checkpoint_forks) AS forks,
    (SELECT count(*)::int FROM memory_nodes) AS memories,
    (SELECT count(*)::int FROM memory_embeddings) AS embeddings,
    (SELECT count(*)::int FROM memory_jobs) AS jobs,
    (SELECT count(*)::int FROM ai_settings) AS settings,
    (SELECT count(*)::int FROM token_logs) AS logs,
    (SELECT count(*)::int FROM model_call_quotas) AS quotas,
    (SELECT count(*)::int FROM owner_activity) AS activity`);
  return result.rows[0];
}
const initialCounts = { sessions: 2, turns: 4, requests: 2, checkpoints: 2, forks: 0, memories: 2, embeddings: 0, jobs: 0, settings: 0, logs: 0, quotas: 0, activity: 0 };

async function sourceState(f: Fixture) {
  return (await f.pg.query("SELECT id,title,owner_id,visibility,turn_count,character,world_state FROM game_sessions WHERE id IN ($1,$2) ORDER BY id", [publicId, privateId])).rows;
}
function expectedSourceState(f: Fixture) {
  return [
    { id: publicId, title: "Открытая встреча", owner_id: f.owner.identity.profileId, visibility: "public", turn_count: 1, character, world_state: world },
    { id: privateId, title: "Личная встреча", owner_id: f.owner.identity.profileId, visibility: "private", turn_count: 1, character, world_state: world },
  ];
}

async function assertInitialContent(f: Fixture) {
  assert.deepEqual(await sourceState(f), expectedSourceState(f));
  assert.deepEqual((await f.pg.query("SELECT session_id,role,content FROM game_turns ORDER BY session_id,role")).rows, [
    { session_id: publicId, role: "narrator", content: "Публичная сцена на площади." },
    { session_id: publicId, role: "player", content: "Я прихожу на встречу." },
    { session_id: privateId, role: "narrator", content: "Личная сцена в закрытом саду." },
    { session_id: privateId, role: "player", content: "Я прихожу на встречу." },
  ]);
  assert.deepEqual((await f.pg.query("SELECT session_id,title,content,source FROM memory_nodes ORDER BY session_id")).rows, [
    { session_id: publicId, title: "Встреча", content: "Публичная сцена на площади.", source: "seed" },
    { session_id: privateId, title: "Встреча", content: "Личная сцена в закрытом саду.", source: "seed" },
  ]);
  assert.deepEqual((await f.pg.query("SELECT session_id,title,turn_number FROM campaign_checkpoints ORDER BY session_id")).rows, [
    { session_id: publicId, title: "До встречи", turn_number: 1 },
    { session_id: privateId, title: "До встречи", turn_number: 1 },
  ]);
  assert.deepEqual((await f.pg.query("SELECT session_id,request_id,status,error FROM turn_requests ORDER BY session_id")).rows, [
    { session_id: publicId, request_id: "saved-request", status: "failed", error: "AI_REQUIRED" },
    { session_id: privateId, request_id: "saved-request", status: "failed", error: "AI_REQUIRED" },
  ]);
}

// Removing ownership guards, treating admin as owner, or admitting private readers
// must fail with both an HTTP boundary assertion and persisted-effect assertions.
test("actual owner-only routes deny public readers and foreign admins before body, provider, or durable effects", async t => {
  const f = await fixture();
  const transport = mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected provider transport"); });
  try {
    assert.equal((await auth.resolve(f.admin.guestToken, f.admin.sessionToken)).isAdmin, true);
    for (const identity of ["reader", "admin"] as const) for (const id of [publicId, privateId]) {
      const checkpointId = f.checkpoints.get(id)!;
      const endpoints: [string, Handler, string, string, unknown?][] = [
        ["act POST", f.route.act, "POST", "act", { action: "Осмотреть площадь", custom: false, expectedTurn: 1, requestId: "denied-action" }],
        ["poll GET", f.route.poll, "GET", "requests/saved-request"],
        ["checkpoints GET", f.route.checkpoints.GET, "GET", "checkpoints"],
        ["checkpoints POST", f.route.checkpoints.POST, "POST", "checkpoints", { title: "Чужая точка", expectedTurn: 1, requestId: "denied-checkpoint" }],
        ["checkpoint DELETE", f.route.deleteCheckpoint, "DELETE", `checkpoints/${checkpointId}`],
        ["fork POST", f.route.fork, "POST", `checkpoints/${checkpointId}/fork`, { title: "Чужая ветка", requestId: "denied-fork" }],
        ["memories GET", f.route.memories, "GET", "memories"],
        ["memory search GET", f.route.search, "GET", "memory/search?q=Встреча"],
        ["memory reindex POST", f.route.reindex, "POST", "memory/reindex"],
        ["portable export GET", f.route.export, "GET", "export?format=json"],
      ];
      if (id === privateId) endpoints.push(
        ["turns GET", f.route.turns, "GET", "turns?before=2"],
        ["markdown export GET", f.route.export, "GET", "export"],
        ["html export GET", f.route.export, "GET", "export?format=html"],
        ["copy POST", f.route.copy, "POST", "copy", { requestId: "denied-copy" }],
      );
      for (const [name, handler, method, path, body] of endpoints) await t.test(`${identity} ${id === publicId ? "public" : "private"}: ${name}`, async () => {
        const response = await f.call(f.cookies[identity], handler, id, method, path, body, checkpointId);
        assert.equal(response.status, 404);
        assert.equal((await response.json()).code, "NOT_FOUND");
        assert.deepEqual(await counts(f), initialCounts);
        await assertInitialContent(f);
        assert.equal(f.afterJobs.length, 0);
        assert.equal(transport.mock.callCount(), 0);
      });
    }
    // A denied caller must not even parse an invalid JSON body, leaking validation
    // details or reaching any downstream operation.
    const badBody = new Request(`https://game.test/api/sessions/${publicId}/act`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    const response = await cookieContext(f.cookies.reader, () => f.route.act(badBody, { params: Promise.resolve({ id: publicId }) }));
    assert.equal(response.status, 404);
    assert.equal(badBody.bodyUsed, false);
    assert.deepEqual(await counts(f), initialCounts);
    await assertInitialContent(f);
  } finally { transport.mock.restore(); await f.close(); }
});

// Over-restricting read access or allowing portable state through the public
// branch must fail; public readers can export a journal and create a private copy.
test("actual public read and copy routes allow readers and foreign admins without changing source ownership", async t => {
  const f = await fixture();
  const transport = mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected provider transport"); });
  try {
    for (const identity of ["owner", "reader", "admin"] as const) await t.test(`${identity} reads public journal`, async () => {
      const turns = await f.call(f.cookies[identity], f.route.turns, publicId, "GET", "turns?before=2");
      assert.equal(turns.status, 200);
      assert.equal(turns.headers.get("cache-control"), "private, no-store");
      const feed = await turns.json();
      assert.deepEqual(feed.turns.map((turn: { role: string; content: string }) => [turn.role, turn.content]), [["player", "Я прихожу на встречу."], ["narrator", "Публичная сцена на площади."]]);
      assert.equal(feed.hasMore, false);
      const markdown = await f.call(f.cookies[identity], f.route.export, publicId, "GET", "export");
      assert.equal(markdown.status, 200);
      assert.match(markdown.headers.get("content-type")!, /text\/markdown/);
      assert.match(await markdown.text(), /Публичная сцена на площади\./);
      const html = await f.call(f.cookies[identity], f.route.export, publicId, "GET", "export?format=html");
      assert.equal(html.status, 200);
      assert.match(html.headers.get("content-type")!, /text\/html/);
      assert.match(await html.text(), /Публичная сцена на площади\./);
      assert.deepEqual(await counts(f), initialCounts);
    });
    for (const identity of ["owner", "reader", "admin"] as const) await t.test(`${identity} receives a personal private copy`, async () => {
      const requestId = `copy-${identity}`;
      const response = await f.call(f.cookies[identity], f.route.copy, publicId, "POST", "copy", { requestId });
      assert.equal(response.status, 201);
      const result = await response.json();
      assert.equal(result.replay, false);
      const expectedOwner = identity === "owner" ? f.owner.identity.profileId : identity === "admin" ? f.admin.identity.profileId : profileIdFromToken(readerToken)!;
      const saved = (await f.pg.query("SELECT owner_id,visibility,turn_count,rules_profile,campaign_mode FROM game_sessions WHERE id=$1", [result.session.id])).rows[0];
      assert.deepEqual(saved, { owner_id: expectedOwner, visibility: "private", turn_count: 1, rules_profile: "narrative", campaign_mode: "preset" });
      assert.deepEqual((await f.pg.query("SELECT role,content FROM game_turns WHERE session_id=$1 ORDER BY role", [result.session.id])).rows, [{ role: "narrator", content: "Публичная сцена на площади." }, { role: "player", content: "Я прихожу на встречу." }]);
      const replay = await f.call(f.cookies[identity], f.route.copy, publicId, "POST", "copy", { requestId });
      assert.equal(replay.status, 200);
      assert.equal((await replay.json()).session.id, result.session.id);
    });
    assert.deepEqual(await counts(f), { ...initialCounts, sessions: 5, turns: 10, memories: 5, embeddings: 3 });
    assert.deepEqual(await sourceState(f), expectedSourceState(f));
    assert.equal(f.afterJobs.length, 0);
    assert.equal(transport.mock.callCount(), 0);
  } finally { transport.mock.restore(); await f.close(); }
});

// Controls make the denial matrix non-vacuous: actual owner handlers must reach
// SQL reads/writes, and a checkpoint fork must retain the campaign owner.
test("actual owner handlers read private data, persist checkpoints and forks, and commit an offline preset turn", async () => {
  const f = await fixture();
  const transport = mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected provider transport"); });
  try {
    const journal = await f.call(f.cookies.owner, f.route.turns, privateId, "GET", "turns?before=2");
    assert.equal(journal.status, 200);
    assert.deepEqual((await journal.json()).turns.map((turn: { content: string }) => turn.content), ["Я прихожу на встречу.", "Личная сцена в закрытом саду."]);
    const memories = await f.call(f.cookies.owner, f.route.memories, privateId, "GET", "memories");
    assert.equal(memories.status, 200);
    const memory = await memories.json();
    assert.deepEqual(memory.memories.map((node: { content: string }) => node.content), ["Личная сцена в закрытом саду."]);
    assert.equal(memory.stats.total, 1);
    assert.equal(memory.stats.tokens, 9);
    const portable = await f.call(f.cookies.owner, f.route.export, privateId, "GET", "export?format=json");
    assert.equal(portable.status, 200, await portable.clone().text());
    const document = await portable.json();
    assert.equal(document.title, "Личная встреча");
    assert.equal(document.snapshot.session.rulesProfile, "narrative");
    assert.equal(document.snapshot.session.campaignMode, "preset");
    assert.deepEqual(document.snapshot.turns.map((turn: { content: string }) => turn.content), ["Я прихожу на встречу.", "Личная сцена в закрытом саду."]);
    assert.deepEqual(document.snapshot.turns.map((turn: { createdAt: string }) => turn.createdAt), ["2026-10-09T10:00:00.000Z", "2026-10-09T10:00:01.000Z"]);
    assert.equal(JSON.stringify(document).includes(f.owner.identity.profileId), false);
    const checkpointId = f.checkpoints.get(privateId)!;
    const list = await f.call(f.cookies.owner, f.route.checkpoints.GET, privateId, "GET", "checkpoints");
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json()).checkpoints.map((checkpoint: { title: string; turnNumber: number }) => [checkpoint.title, checkpoint.turnNumber]), [["До встречи", 1]]);
    const fork = await f.call(f.cookies.owner, f.route.fork, privateId, "POST", `checkpoints/${checkpointId}/fork`, { title: "Другая встреча", requestId: "owner-fork" }, checkpointId);
    assert.equal(fork.status, 201);
    const branchId = (await fork.json()).session.id;
    assert.deepEqual((await f.pg.query("SELECT title,owner_id,visibility,turn_count FROM game_sessions WHERE id=$1", [branchId])).rows, [{ title: "Другая встреча", owner_id: f.owner.identity.profileId, visibility: "private", turn_count: 1 }]);
    assert.equal((await f.pg.query<{ n: number }>("SELECT count(*)::int n FROM checkpoint_forks WHERE checkpoint_id=$1 AND branch_id=$2", [checkpointId, branchId])).rows[0].n, 1);
    assert.equal(f.afterJobs.length, 1);
    const replay = await f.call(f.cookies.owner, f.route.fork, privateId, "POST", `checkpoints/${checkpointId}/fork`, { title: "Другая встреча", requestId: "owner-fork" }, checkpointId);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).session.id, branchId);
    assert.equal(f.afterJobs.length, 1);
    const removed = await f.call(f.cookies.owner, f.route.deleteCheckpoint, privateId, "DELETE", `checkpoints/${checkpointId}`, undefined, checkpointId);
    assert.equal(removed.status, 200);
    assert.equal((await f.pg.query<{ n: number }>("SELECT count(*)::int n FROM campaign_checkpoints WHERE id=$1", [checkpointId])).rows[0].n, 0);
    assert.equal((await f.pg.query<{ n: number }>("SELECT count(*)::int n FROM game_sessions WHERE id=$1", [branchId])).rows[0].n, 1);

    const act = await f.call(f.cookies.owner, f.route.act, privateId, "POST", "act", { action: "Осмотреть площадь", custom: false, expectedTurn: 1, requestId: "owner-action" });
    assert.equal(act.status, 200);
    const committed = await act.json();
    assert.equal(committed.ok, true);
    assert.equal(committed.turnNumber, 2);
    assert.equal(committed.playerAction, "Осмотреть площадь");
    assert.deepEqual((await f.pg.query("SELECT turn_number,role FROM game_turns WHERE session_id=$1 ORDER BY turn_number,role", [privateId])).rows, [{ turn_number: 1, role: "narrator" }, { turn_number: 1, role: "player" }, { turn_number: 2, role: "narrator" }, { turn_number: 2, role: "player" }]);
    assert.equal((await f.pg.query<{ turn_count: number }>("SELECT turn_count FROM game_sessions WHERE id=$1", [privateId])).rows[0].turn_count, 2);
    const poll = await cookieContext(f.cookies.owner, () => f.route.poll(new Request(`https://game.test/api/sessions/${privateId}/requests/owner-action`), { params: Promise.resolve({ id: privateId, requestId: "owner-action" }) }));
    assert.equal(poll.status, 200);
    const polled = await poll.json();
    assert.equal(polled.status, "completed");
    assert.equal(polled.result.turnNumber, 2);
    assert.equal(polled.result.playerAction, "Осмотреть площадь");
    assert.equal((await counts(f)).activity, 0);
    assert.equal(transport.mock.callCount(), 0);
  } finally { transport.mock.restore(); await f.close(); }
});

// Bypassing owner access, using another campaign's settings, or indexing/searching
// foreign memories must fail even when indexing is configured and operational.
test("actual owner memory reindex and search persist only the requested campaign and deny operational access to foreigners", async () => {
  const f = await fixture();
  const oldSecretKeys = process.env.CHRONICLE_SECRET_KEYS;
  const oldActiveKey = process.env.CHRONICLE_SECRET_ACTIVE_KEY;
  const vector = [1, ...Array<number>(127).fill(0)];
  let providerCalls = 0;
  const transport = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    providerCalls++;
    assert.equal(String(input), "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "synthetic-route-embedding-key");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.outputDimensionality, 128);
    assert.equal(body.model, "models/gemini-embedding-2");
    return Response.json({ embedding: { values: vector } });
  });
  try {
    process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ test: Buffer.alloc(32, 7).toString("base64") });
    process.env.CHRONICLE_SECRET_ACTIVE_KEY = "test";
    const { prepareGeminiKeysWrite } = await import("../src/lib/ai-settings");
    await f.pg.query("INSERT INTO ai_settings(id,keys,enforce_limits,embedding_dims,embeddings_enabled) VALUES ($1,$2,false,128,true)", [f.owner.identity.profileId, prepareGeminiKeysWrite(f.owner.identity.profileId, ["synthetic-route-embedding-key"])]);
    const indexed = await f.call(f.cookies.owner, f.route.reindex, privateId, "POST", "memory/reindex");
    assert.equal(indexed.status, 200, await indexed.clone().text());
    const result = await indexed.json();
    assert.deepEqual(result.backfill, { queued: 1, total: 1 });
    assert.equal(result.indexed, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.pending, 0);
    assert.equal(result.stats.ready, 1);
    assert.deepEqual((await f.pg.query("SELECT session_id,status,attempts,dims,lease_token,lease_expires_at,vector FROM memory_embeddings")).rows, [{ session_id: privateId, status: "ready", attempts: 1, dims: 128, lease_token: null, lease_expires_at: null, vector }]);
    const search = await f.call(f.cookies.owner, f.route.search, privateId, "GET", "memory/search?q=Личная%20встреча&k=3");
    assert.equal(search.status, 200, await search.clone().text());
    const found = await search.json();
    assert.equal(found.backend, "postgres");
    assert.deepEqual(found.results.map((node: { title: string; content: string; similarity: number }) => [node.title, node.content, node.similarity]), [["Встреча", "Личная сцена в закрытом саду.", 1]]);
    assert.equal(providerCalls, 2);
    for (const identity of ["reader", "admin"] as const) for (const id of [publicId, privateId]) {
      for (const [handler, method, path] of [[f.route.reindex, "POST", "memory/reindex"], [f.route.search, "GET", "memory/search?q=Встреча"]] as const) {
        const denied = await f.call(f.cookies[identity], handler, id, method, path);
        assert.equal(denied.status, 404);
        assert.equal((await denied.json()).code, "NOT_FOUND");
        assert.equal(providerCalls, 2);
        assert.deepEqual(await counts(f), { ...initialCounts, embeddings: 1, settings: 1, logs: 2, quotas: 1 });
        assert.deepEqual((await f.pg.query("SELECT owner_id,scope,model,attempts::int FROM model_call_quotas")).rows, [{ owner_id: f.owner.identity.profileId, scope: "embedding", model: "gemini-embedding-2", attempts: 2 }]);
      }
    }
    await assertInitialContent(f);
    assert.equal(f.afterJobs.length, 0);
  } finally {
    if (oldSecretKeys === undefined) delete process.env.CHRONICLE_SECRET_KEYS; else process.env.CHRONICLE_SECRET_KEYS = oldSecretKeys;
    if (oldActiveKey === undefined) delete process.env.CHRONICLE_SECRET_ACTIVE_KEY; else process.env.CHRONICLE_SECRET_ACTIVE_KEY = oldActiveKey;
    transport.mock.restore(); await f.close();
  }
});

// Revoking the admitted account while readJsonObject waits must not silently
// create a guest-owned copy or admit a foreground turn using the former owner.
for (const endpoint of ["copy", "act", "checkpoints", "fork"] as const) test(`${endpoint} actual handler rejects identity revoked during event-gated body read`, { timeout: 20_000 }, async () => {
  const f = await fixture();
  const transport = mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected provider transport"); });
  let resumeBody!: () => void;
  let pending: Promise<Response> | undefined;
  try {
    let enterBody!: () => void;
    const entered = new Promise<void>(resolve => { enterBody = resolve; });
    const resume = new Promise<void>(resolve => { resumeBody = resolve; });
    const payload = endpoint === "copy" ? { requestId: "revoked-copy" }
      : endpoint === "act" ? { action: "Осмотреть площадь", custom: false, expectedTurn: 1, requestId: "revoked-act" }
      : { title: "Запоздалый снимок", expectedTurn: 1, requestId: `revoked-${endpoint}` };
    const body = new ReadableStream<Uint8Array>({ async pull(controller) {
      enterBody(); await resume;
      controller.enqueue(new TextEncoder().encode(JSON.stringify(payload))); controller.close();
    } }, { highWaterMark: 0 });
    const handler = endpoint === "checkpoints" ? f.route.checkpoints.POST : f.route[endpoint];
    pending = cookieContext(f.cookies.owner, () => handler(new Request(`https://game.test/api/sessions/${publicId}/${endpoint}`, {
      method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half",
    } as RequestInit), { params: Promise.resolve({ id: publicId, checkpointId: f.checkpoints.get(publicId)! }) }), f.afterJobs);
    await entered;
    assert.deepEqual((await f.pg.query("SELECT owner_id FROM owner_activity")).rows, [{ owner_id: f.owner.identity.profileId }]);
    const authAction = (await import("../src/app/api/auth/[action]/route")).POST;
    const logout = await authAction(new Request("https://game.test/api/auth/logout", { method: "POST", headers: { cookie: f.cookies.owner, origin: "https://game.test", "content-type": "application/json" }, body: "{}" }), { params: Promise.resolve({ action: "logout" }) });
    assert.equal(logout.status, 200);
    assert.equal((await auth.resolve(f.owner.guestToken, f.owner.sessionToken)).kind, "guest");
    resumeBody();
    const response = await pending;
    assert.deepEqual(await counts(f), initialCounts, "revoked requests must leave all durable rows unchanged");
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, "IDENTITY_CHANGED");
    await assertInitialContent(f);
    assert.equal(f.afterJobs.length, 0);
    assert.equal(transport.mock.callCount(), 0);
    // Public access remains available to the now-valid guest on a later request.
    const later = await f.call(`chronicle_guest=${f.owner.guestToken}`, f.route.turns, publicId, "GET", "turns?before=2");
    assert.equal(later.status, 200);
  } finally {
    resumeBody?.();
    await pending?.catch(() => {});
    transport.mock.restore(); await f.close();
  }
});

for (const operation of ["delete", "fork"] as const) test(`${operation} rejects a checkpoint UUID from another campaign without effects`, async () => {
  const f = await fixture();
  try {
    const checkpointId = f.checkpoints.get(publicId)!;
    const response = await f.call(f.cookies.owner, operation === "delete" ? f.route.deleteCheckpoint : f.route.fork, privateId,
      operation === "delete" ? "DELETE" : "POST", `checkpoints/${checkpointId}/${operation}`, operation === "delete" ? undefined : { title: "Чужая точка", requestId: "foreign-checkpoint" }, checkpointId);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "NOT_FOUND");
    assert.deepEqual(await counts(f), initialCounts);
    await assertInitialContent(f);
    assert.equal(f.afterJobs.length, 0);
  } finally { await f.close(); }
});

test("reindex rejects revocation after campaign lookup before config authorization without effects", { timeout: 20_000 }, async () => {
  const f = await fixture();
  const { pool } = await import("../src/db");
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
  let held = false, pending: Promise<Response> | undefined;
  const transport = mock.method(globalThis, "fetch", async () => { throw new Error("Unauthorized reindex called a provider"); });
  const query = mock.method(pool, "query", (async (...args: Parameters<typeof f.run>) => {
    const sql = typeof args[0] === "string" ? args[0] : args[0].text;
    const result = await f.run(...args);
    if (!held && sql.startsWith('select "id" from "game_sessions"')) { held = true; enter(); await released; }
    return result;
  }) as never);
  try {
    pending = f.call(f.cookies.owner, f.route.reindex, privateId, "POST", "memory/reindex");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([entered, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Timed out: reindex campaign lookup")), 8000); })]); }
    finally { clearTimeout(timer); }
    await auth.logout(f.owner.sessionToken);
    release();
    const response = await pending;
    assert.deepEqual(await counts(f), initialCounts);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, "IDENTITY_CHANGED");
    await assertInitialContent(f);
    assert.equal(f.afterJobs.length, 0);
    assert.equal(transport.mock.callCount(), 0);
  } finally { release(); await pending?.catch(() => {}); query.mock.restore(); transport.mock.restore(); await f.close(); }
});
