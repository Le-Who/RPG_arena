import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { auth } from "../src/lib/auth";
import { commitmentVersion } from "../src/lib/world-commitments";
import type { Commitment } from "../src/lib/world-life";

const publicId = "20000000-0000-4000-8000-000000000001";
const privateId = "20000000-0000-4000-8000-000000000002";
const character = { name: "Анна", archetype: "Горожанка", level: 1, xp: 0, hp: 10, maxHp: 10, gold: 5, stats: {}, skills: [], traits: [], conditions: [], backstory: "Живёт у гавани.", appearance: "Серое пальто." };
const commitment: Commitment = { id: "c1", title: "Встреча", parties: ["Мира"], place: "Площадь", due: { day: 2, minute: 600 }, status: "accepted", createdTurn: 1, updatedTurn: 1, note: "" };
const world = { worldName: "Гавань", tone: "Спокойный", era: "Сегодня", mainQuest: "Встреча", currentLocation: "Площадь", factions: [], flags: {}, danger: 0, chapter: 1, clock: { day: 1, minute: 600 }, commitments: [commitment] };
type Handler = (req: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
type Endpoint = { name: string; method: string; path: string; handler: Handler; payload: unknown };

async function fixture() {
  const database = await accountsDb();
  const oldKey = process.env.POLLINATIONS_API_KEY;
  const oldDisabled = process.env.CHRONICLE_VISUALS_DISABLED;
  try {
    const owner = await auth.register("d".repeat(64), "bodyowner", "correct horse battery staple");
    const admin = await auth.register("e".repeat(64), "bodyadmin", "correct horse battery staple");
    process.env.CHRONICLE_ADMIN_ACCOUNT_IDS = admin.identity.account!.id;
    process.env.POLLINATIONS_API_KEY = "synthetic-body-authority-key";
    delete process.env.CHRONICLE_VISUALS_DISABLED;
    const cookies = { owner: `chronicle_guest=${owner.guestToken}; chronicle_session=${owner.sessionToken}`, admin: `chronicle_guest=${admin.guestToken}; chronicle_session=${admin.sessionToken}`, reader: `chronicle_guest=${"f".repeat(64)}` };
    for (const [id, visibility] of [[publicId, "public"], [privateId, "private"]]) {
      await database.pg.query("INSERT INTO game_sessions(id,title,owner_id,visibility,character,world_state,turn_count,campaign_mode,rules_profile) VALUES ($1,'Встреча',$2,$3,$4,$5,1,'preset','narrative')", [id, owner.identity.profileId, visibility, JSON.stringify(character), JSON.stringify(world)]);
      await database.pg.query("INSERT INTO npcs(session_id,key,name,status) VALUES ($1,'mira','Мира','alive')", [id]);
      await database.pg.query("INSERT INTO visual_identities(session_id,subject_key,subject_name,passport,seed) VALUES ($1,'hero','Анна','Серое пальто.',7)", [id]);
    }
    const endpoints: Endpoint[] = [
      { name: "session", method: "PATCH", path: "", handler: (await import("../src/app/api/sessions/[id]/route")).PATCH, payload: { title: "Поздняя правка", visibility: "private", narrator: { verbosity: "brief" } } },
      { name: "commitments", method: "PATCH", path: "commitments", handler: (await import("../src/app/api/sessions/[id]/commitments/route")).PATCH, payload: { id: "c1", version: await commitmentVersion(commitment), action: "fulfilled", note: "встреча состоялась" } },
      { name: "social", method: "PATCH", path: "social", handler: (await import("../src/app/api/sessions/[id]/social/route")).PATCH, payload: { op: "knowledge.add", npcKey: "mira", text: "Ключ у героя" } },
      { name: "visuals", method: "POST", path: "visuals", handler: (await import("../src/app/api/sessions/[id]/visuals/route")).POST, payload: { kind: "portrait", subject: "hero" } },
      { name: "identities", method: "PATCH", path: "visuals/identities", handler: (await import("../src/app/api/sessions/[id]/visuals/identities/route")).PATCH, payload: { subjectKey: "hero", passport: "Синее пальто." } },
    ];
    const adminHandler = (await import("../src/app/api/system/visual-model/route")).PATCH;
    const jobs: (() => Promise<void>)[] = [];
    return { ...database, owner, admin, cookies, endpoints, adminHandler, jobs, async close() {
      delete process.env.CHRONICLE_ADMIN_ACCOUNT_IDS;
      if (oldKey === undefined) delete process.env.POLLINATIONS_API_KEY; else process.env.POLLINATIONS_API_KEY = oldKey;
      if (oldDisabled === undefined) delete process.env.CHRONICLE_VISUALS_DISABLED; else process.env.CHRONICLE_VISUALS_DISABLED = oldDisabled;
      await database.close();
    } };
  } catch (error) { delete process.env.CHRONICLE_ADMIN_ACCOUNT_IDS; if (oldKey === undefined) delete process.env.POLLINATIONS_API_KEY; else process.env.POLLINATIONS_API_KEY = oldKey; await database.close(); throw error; }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function assertUnchanged(f: Fixture) {
  assert.deepEqual((await f.pg.query("SELECT id,title,owner_id,visibility,turn_count,character,world_state FROM game_sessions ORDER BY id")).rows, [
    { id: publicId, title: "Встреча", owner_id: f.owner.identity.profileId, visibility: "public", turn_count: 1, character, world_state: world },
    { id: privateId, title: "Встреча", owner_id: f.owner.identity.profileId, visibility: "private", turn_count: 1, character, world_state: world },
  ]);
  assert.deepEqual((await f.pg.query("SELECT session_id,subject_key,subject_name,passport,seed,reference_visual_id FROM visual_identities ORDER BY session_id")).rows, [
    { session_id: publicId, subject_key: "hero", subject_name: "Анна", passport: "Серое пальто.", seed: 7, reference_visual_id: null },
    { session_id: privateId, subject_key: "hero", subject_name: "Анна", passport: "Серое пальто.", seed: 7, reference_visual_id: null },
  ]);
  assert.deepEqual((await f.pg.query(`SELECT
    (SELECT count(*)::int FROM game_turns) AS turns,
    (SELECT count(*)::int FROM turn_requests) AS requests,
    (SELECT count(*)::int FROM quests) AS quests,
    (SELECT count(*)::int FROM memory_nodes) AS memories,
    (SELECT count(*)::int FROM memory_embeddings) AS embeddings,
    (SELECT count(*)::int FROM memory_jobs) AS jobs,
    (SELECT count(*)::int FROM scene_visuals) AS visuals,
    (SELECT count(*)::int FROM visual_quota_reservations) AS reservations,
    (SELECT count(*)::int FROM visual_settings) AS settings,
    (SELECT count(*)::int FROM token_logs) AS logs,
    (SELECT count(*)::int FROM model_call_quotas) AS quotas,
    (SELECT count(*)::int FROM owner_activity) AS activity`)).rows, [{ turns: 0, requests: 0, quests: 0, memories: 0, embeddings: 0, jobs: 0, visuals: 0, reservations: 0, settings: 0, logs: 0, quotas: 0, activity: 0 }]);
  assert.equal(f.jobs.length, 0);
}

function request(endpoint: Endpoint, id: string, body: BodyInit = JSON.stringify(endpoint.payload)) {
  return new Request(`https://game.test/api/sessions/${id}/${endpoint.path}`, { method: endpoint.method, headers: { "content-type": "application/json", origin: "https://game.test" }, body, duplex: "half" } as RequestInit);
}

function bodyGate(payload: unknown) {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const resumed = new Promise<void>(resolve => { release = resolve; });
  const body = new ReadableStream<Uint8Array>({ async pull(controller) {
    enter(); await resumed;
    controller.enqueue(new TextEncoder().encode(JSON.stringify(payload))); controller.close();
  } }, { highWaterMark: 0 });
  return { body, entered, release };
}

// Removing the fresh check after readJsonObject must admit a formerly owned write
// and fail these literal durable-state assertions, using a valid request body.
for (const name of ["session", "commitments", "social", "visuals", "identities", "admin"] as const) test(`${name} rejects real logout while valid request body is gated`, { timeout: 20_000 }, async () => {
  const f = await fixture();
  const endpoint = f.endpoints.find(x => x.name === name);
  const actor = name === "admin" ? f.admin : f.owner;
  const gate = bodyGate(endpoint?.payload ?? { model: "fixture/image" });
  let pending: Promise<Response> | undefined;
  // Catalogue is synthetic but otherwise operational, so admin baseline reaches
  // persistence; a corrected route must deny before contacting this transport.
  const transport = mock.method(globalThis, "fetch", async () => Response.json([{ name: "fixture/image", category: "image", community: false, input_modalities: ["text"], output_modalities: ["image"], supported_endpoints: ["/image/{prompt}"] }]));
  try {
    const req = endpoint ? request(endpoint, publicId, gate.body) : new Request("https://game.test/api/system/visual-model", { method: "PATCH", headers: { "content-type": "application/json", origin: "https://game.test" }, body: gate.body, duplex: "half" } as RequestInit);
    pending = cookieContext(f.cookies[name === "admin" ? "admin" : "owner"], () => endpoint ? endpoint.handler(req, { params: Promise.resolve({ id: publicId }) }) : f.adminHandler(req), f.jobs);
    await gate.entered;
    assert.deepEqual((await f.pg.query("SELECT owner_id FROM owner_activity")).rows, [{ owner_id: actor.identity.profileId }]);
    await auth.logout(actor.sessionToken);
    assert.equal((await auth.resolve(actor.guestToken, actor.sessionToken)).kind, "guest");
    gate.release();
    const response = await pending;
    await assertUnchanged(f);
    assert.equal(response.status, name === "admin" ? 403 : 401);
    assert.equal((await response.json()).code, name === "admin" ? "ADMIN_REQUIRED" : "IDENTITY_CHANGED");
    assert.equal(transport.mock.callCount(), 0);
  } finally { gate.release(); await pending?.catch(() => {}); transport.mock.restore(); await f.close(); }
});

test("owner mutation routes reject public/private readers and foreign admins before reading valid bodies", async t => {
  const f = await fixture();
  const transport = mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected provider transport"); });
  try {
    for (const actor of ["reader", "admin"] as const) for (const id of [publicId, privateId]) for (const endpoint of f.endpoints) await t.test(`${actor} ${id === publicId ? "public" : "private"} ${endpoint.name}`, async () => {
      const req = request(endpoint, id);
      const response = await cookieContext(f.cookies[actor], () => endpoint.handler(req, { params: Promise.resolve({ id }) }), f.jobs);
      assert.equal(response.status, 404);
      assert.equal((await response.json()).code, "NOT_FOUND");
      assert.equal(req.bodyUsed, false);
      await assertUnchanged(f);
      assert.equal(transport.mock.callCount(), 0);
    });
    for (const actor of ["owner", "reader"] as const) {
      const req = new Request("https://game.test/api/system/visual-model", { method: "PATCH", headers: { "content-type": "application/json", origin: "https://game.test" }, body: JSON.stringify({ model: "fixture/image" }) });
      const response = await cookieContext(f.cookies[actor], () => f.adminHandler(req), f.jobs);
      assert.equal(response.status, 403);
      assert.equal(req.bodyUsed, false);
      await assertUnchanged(f);
    }
  } finally { transport.mock.restore(); await f.close(); }
});

// A valid catalogue may arrive after logout. Saving under the captured admin
// would be a privileged effect despite the request's body having passed earlier.
test("administrator logout during catalogue read prevents saving the selected model", { timeout: 20_000 }, async () => {
  const f = await fixture();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const resumed = new Promise<void>(resolve => { release = resolve; });
  const transport = mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    assert.equal(String(url), "https://gen.pollinations.ai/image/models");
    enter(); await resumed;
    return Response.json([{ name: "fixture/image", category: "image", community: false, input_modalities: ["text"], output_modalities: ["image"], supported_endpoints: ["/image/{prompt}"] }]);
  });
  let pending: Promise<Response> | undefined;
  try {
    pending = cookieContext(f.cookies.admin, () => f.adminHandler(new Request("https://game.test/api/system/visual-model", { method: "PATCH", headers: { "content-type": "application/json", origin: "https://game.test" }, body: JSON.stringify({ model: "fixture/image" }) })), f.jobs);
    await entered;
    assert.deepEqual((await f.pg.query("SELECT owner_id FROM owner_activity")).rows, [{ owner_id: f.admin.identity.profileId }]);
    await auth.logout(f.admin.sessionToken);
    assert.equal((await auth.resolve(f.admin.guestToken, f.admin.sessionToken)).kind, "guest");
    release();
    const response = await pending;
    await assertUnchanged(f);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "ADMIN_REQUIRED");
    assert.equal(transport.mock.callCount(), 1);
  } finally { release(); await pending?.catch(() => {}); transport.mock.restore(); await f.close(); }
});

test("fresh owners and administrator retain valid mutation controls", async () => {
  const f = await fixture();
  const transport = mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    assert.equal(String(url), "https://gen.pollinations.ai/image/models");
    return Response.json([{ name: "fixture/image", category: "image", community: false, input_modalities: ["text"], output_modalities: ["image"], supported_endpoints: ["/image/{prompt}"] }]);
  });
  try {
    for (const endpoint of f.endpoints) {
      const response = await cookieContext(f.cookies.owner, () => endpoint.handler(request(endpoint, privateId), { params: Promise.resolve({ id: privateId }) }), f.jobs);
      assert.equal(response.status, endpoint.name === "visuals" ? 201 : 200, await response.clone().text());
    }
    const saved = (await f.pg.query<{ title: string; owner_id: string; world_state: { commitments: Commitment[]; npcBonds: { knows: { text: string; source: string }[] }[] } }>("SELECT title,owner_id,world_state FROM game_sessions WHERE id=$1", [privateId])).rows[0];
    assert.equal(saved.title, "Поздняя правка");
    assert.equal(saved.owner_id, f.owner.identity.profileId);
    assert.equal(saved.world_state.commitments[0].status, "fulfilled");
    assert.equal(saved.world_state.npcBonds[0].knows[0].text, "Ключ у героя");
    assert.equal(saved.world_state.npcBonds[0].knows[0].source, "owner");
    assert.deepEqual((await f.pg.query("SELECT passport FROM visual_identities WHERE session_id=$1", [privateId])).rows, [{ passport: "Синее пальто." }]);
    assert.deepEqual((await f.pg.query("SELECT session_id,owner_id,kind,subject_key,status FROM scene_visuals")).rows, [{ session_id: privateId, owner_id: f.owner.identity.profileId, kind: "portrait", subject_key: "hero", status: "pending" }]);
    assert.equal((await f.pg.query<{ n: number }>("SELECT count(*)::int n FROM visual_quota_reservations")).rows[0].n, 1);
    assert.equal((await f.pg.query<{ n: number }>("SELECT count(*)::int n FROM memory_nodes")).rows[0].n, 2);
    assert.equal(f.jobs.length, 2);
    const response = await cookieContext(f.cookies.admin, () => f.adminHandler(new Request("https://game.test/api/system/visual-model", { method: "PATCH", headers: { "content-type": "application/json", origin: "https://game.test" }, body: JSON.stringify({ model: "fixture/image" }) })), f.jobs);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual((await f.pg.query("SELECT model,updated_by FROM visual_settings")).rows, [{ model: "fixture/image", updated_by: f.admin.identity.account!.id }]);
    assert.equal(transport.mock.callCount(), 1);
    assert.equal((await f.pg.query<{ n: number }>("SELECT count(*)::int n FROM owner_activity")).rows[0].n, 0);
  } finally { transport.mock.restore(); await f.close(); }
});
