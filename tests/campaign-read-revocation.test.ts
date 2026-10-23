import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { auth } from "../src/lib/auth";
import { profileIdFromToken } from "../src/lib/guest-identity";

const sessionId = "64000000-0000-4000-8000-000000000001";
const readerToken = "b".repeat(64);
type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;

async function fixture() {
  const database = await accountsDb();
  try {
    const owner = await auth.register("a".repeat(64), "readowner", "correct horse battery staple");
    await database.pg.query(`INSERT INTO game_sessions(id,owner_id,title,visibility,character,world_state,turn_count,rules_profile)
      VALUES ($1,$2,'Закрываемая история','public',$3,$4,1,'narrative')`, [sessionId, owner.identity.profileId,
      JSON.stringify({ name: "Анна", archetype: "Горожанка", level: 1, xp: 0, hp: 0, maxHp: 0, gold: 0, stats: {}, skills: [], traits: [], conditions: [], backstory: "", appearance: "" }),
      JSON.stringify({ worldName: "Гавань", tone: "Спокойный", era: "Сегодня", mainQuest: "Встреча", currentLocation: "Площадь", factions: [], flags: {}, danger: 0, chapter: 1 })]);
    await database.pg.query("INSERT INTO game_turns(session_id,turn_number,role,content,choices) VALUES ($1,1,'narrator','Частная запись о встрече.','[]')", [sessionId]);
    await database.pg.query("INSERT INTO turn_requests(session_id,request_id,input_hash,action,is_free,base_turn,status,stage) VALUES ($1,'saved-request','fixture','Встреча',true,1,'failed','failed')", [sessionId]);
    const poll = (await import("../src/app/api/sessions/[id]/requests/[requestId]/route")).GET;
    const endpoints: { name: string; path: string; handler: Handler; ownerOnly?: boolean }[] = [
      { name: "session", path: "", handler: (await import("../src/app/api/sessions/[id]/route")).GET },
      { name: "turns", path: "/turns?before=2", handler: (await import("../src/app/api/sessions/[id]/turns/route")).GET },
      { name: "recap", path: "/recap", handler: (await import("../src/app/api/sessions/[id]/recap/route")).GET },
      { name: "gallery", path: "/visuals", handler: (await import("../src/app/api/sessions/[id]/visuals/route")).GET },
      { name: "markdown", path: "/export", handler: (await import("../src/app/api/sessions/[id]/export/route")).GET },
      { name: "html", path: "/export?format=html", handler: (await import("../src/app/api/sessions/[id]/export/route")).GET },
      { name: "checkpoints", path: "/checkpoints", ownerOnly: true, handler: (await import("../src/app/api/sessions/[id]/checkpoints/route")).GET },
      { name: "memories", path: "/memories", ownerOnly: true, handler: (await import("../src/app/api/sessions/[id]/memories/route")).GET },
      { name: "request status", path: "/requests/saved-request", ownerOnly: true, handler: (request, { params }) => poll(request, { params: params.then(({ id }) => ({ id, requestId: "saved-request" })) }) },
    ];
    const ownerCookie = `chronicle_guest=${owner.guestToken}; chronicle_session=${owner.sessionToken}`;
    const jobs: (() => Promise<void>)[] = [];
    const call = (endpoint: typeof endpoints[number], cookie = `chronicle_guest=${readerToken}`) => cookieContext(cookie,
      () => endpoint.handler(new Request(`https://game.test/api/sessions/${sessionId}${endpoint.path}`), { params: Promise.resolve({ id: sessionId }) }), jobs);
    return { ...database, owner, ownerCookie, endpoints, jobs, call };
  } catch (error) { await database.close(); throw error; }
}

// Returning a response authorized only at admission leaks data when publication
// or the account is revoked while a database read is pending.
for (const change of ["unpublish", "logout"] as const) test(`campaign GET routes reject ${change} after their initial access read`, { timeout: 30_000 }, async t => {
  const f = await fixture();
  const { pool } = await import("../src/db");
  try {
    for (const endpoint of f.endpoints.filter(endpoint => change === "logout" || !endpoint.ownerOnly)) await t.test(endpoint.name, async () => {
      await f.pg.query("UPDATE game_sessions SET visibility='public' WHERE id=$1", [sessionId]);
      // Log back in for each revocation case so the initial identity is valid.
      const account = change === "logout" ? await auth.login(f.owner.guestToken, "readowner", "correct horse battery staple") : null;
      const cookie = account ? `chronicle_guest=${account.guestToken}; chronicle_session=${account.sessionToken}` : undefined;
      let enter!: () => void, release!: () => void, pending: Promise<Response> | undefined;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const resumed = new Promise<void>(resolve => { release = resolve; });
      let held = false;
      const query = mock.method(pool, "query", (async (...args: Parameters<typeof f.run>) => {
        const sql = typeof args[0] === "string" ? args[0] : args[0].text;
        const result = await f.run(...args);
        if (!held && sql.startsWith('select "owner_id", "visibility" from "game_sessions"')) {
          held = true; enter(); await resumed;
        }
        return result;
      }) as never);
      try {
        pending = f.call(endpoint, cookie);
        await entered;
        if (account) await auth.logout(account.sessionToken);
        else await f.pg.query("UPDATE game_sessions SET visibility='private' WHERE id=$1", [sessionId]);
        release();
        const response = await pending;
        assert.equal(response.status, account ? 401 : 404);
        assert.equal((await response.json()).code, account ? "IDENTITY_CHANGED" : "NOT_FOUND");
        assert.deepEqual((await f.pg.query("SELECT owner_id FROM owner_activity")).rows, []);
        assert.equal(f.jobs.length, 0);
      } finally { release(); await pending?.catch(() => {}); query.mock.restore(); }
    });
  } finally { await f.close(); }
});

test("public readers and owners retain successful read controls", async () => {
  const f = await fixture();
  try {
    assert.notEqual(profileIdFromToken(readerToken), f.owner.identity.profileId);
    for (const endpoint of f.endpoints) {
      if (!endpoint.ownerOnly) assert.equal((await f.call(endpoint)).status, 200, endpoint.name);
      const owner = await f.call(endpoint, f.ownerCookie);
      assert.equal(owner.status, 200, endpoint.name);
      assert.equal(owner.headers.get("cache-control"), "private, no-store");
    }
    await f.pg.query("UPDATE game_sessions SET visibility='private' WHERE id=$1", [sessionId]);
    for (const endpoint of f.endpoints) assert.equal((await f.call(endpoint, f.ownerCookie)).status, 200, endpoint.name);
    assert.deepEqual((await f.pg.query("SELECT owner_id FROM owner_activity")).rows, []);
  } finally { await f.close(); }
});
