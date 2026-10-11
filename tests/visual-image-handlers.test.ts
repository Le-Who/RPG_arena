import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { profileIdFromToken } from "../src/lib/guest-identity";

const ownerToken = "a".repeat(64), readerToken = "b".repeat(64);
const owner = profileIdFromToken(ownerToken)!;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==", "base64");
type StoredVisual = Record<string, unknown> & { id: string; updated_at: Date; latency_ms: number | null };

async function fixture() {
  const f = await accountsDb();
  const { GET, DELETE } = await import("../src/app/api/sessions/[id]/visuals/[visualId]/route");
  const sessions = { public: randomUUID(), private: randomUUID() };
  const visuals: Record<string, string> = {};
  for (const [visibility, session] of Object.entries(sessions)) {
    await f.pg.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state,visibility) VALUES ($1,$2,'Visual fixture','{}','{}',$3)", [session, owner, visibility]);
    for (const status of ["pending", "failed", "ready"]) {
      const visual = randomUUID(); visuals[`${visibility}:${status}`] = visual;
      await f.pg.query(`INSERT INTO scene_visuals(id,session_id,owner_id,kind,subject_key,caption,prompt,provider,model,seed,width,height,status,attempts,error,image,mime_type)
        VALUES ($1,$2,$3,'portrait','hero','Портрет','Синтетический портрет','pollinations','fixture-model',42,768,960,$4,$5,$6,$7,$8)`,
      [visual, session, owner, status, status === "pending" ? 0 : 1, status === "failed" ? "PROVIDER_HTTP_503" : null, status === "ready" ? png : null, status === "ready" ? "image/png" : null]);
      await f.pg.query("INSERT INTO visual_quota_reservations(quota_scope,visual_id) VALUES ($1,$2)", [`owner:${owner}`, visual]);
    }
  }
  const call = (token: string, session: string, visual: string, retry = false, method: "GET" | "DELETE" = "GET") => {
    const cookie = `chronicle_guest=${token}`;
    const request = new Request(`https://game.test/api/sessions/${session}/visuals/${visual}${retry ? "?retry=1" : ""}`, { method, headers: { cookie } });
    // Direct production handler invocation with actual Next request storage.
    // This does not claim browser-cookie-jar or Next server dispatch coverage.
    return cookieContext(cookie, () => (method === "GET" ? GET : DELETE)(request, { params: Promise.resolve({ id: session, visualId: visual }) }));
  };
  const state = async () => ({
    sessions: (await f.pg.query("SELECT * FROM game_sessions ORDER BY id")).rows,
    visuals: (await f.pg.query<StoredVisual>("SELECT * FROM scene_visuals ORDER BY id")).rows,
    ledger: (await f.pg.query("SELECT * FROM visual_quota_reservations ORDER BY id")).rows,
    identities: (await f.pg.query("SELECT * FROM visual_identities ORDER BY id")).rows,
    activity: (await f.pg.query("SELECT * FROM owner_activity ORDER BY id")).rows,
  });
  return { ...f, sessions, visuals, call, state };
}

// Removing the owner-generation guard, losing campaign scoping, or treating a
// ready read as generation must change HTTP bytes/status or the persisted state.
test("actual image GET enforces public cached reading and owner generation with no effects on refusal", async t => {
  const f = await fixture();
  let calls = 0;
  const transport = mock.method(globalThis, "fetch", async () => { calls++; throw new Error("Unexpected provider transport"); });
  const oldKey = process.env.POLLINATIONS_API_KEY, oldDisabled = process.env.CHRONICLE_VISUALS_DISABLED;
  try {
    delete process.env.POLLINATIONS_API_KEY;
    process.env.CHRONICLE_VISUALS_DISABLED = "1";
    const before = await f.state();
    for (const [token, visibility] of [[ownerToken, "public"], [readerToken, "public"], [ownerToken, "private"]] as const) await t.test(`${visibility} cached ${token === ownerToken ? "owner" : "reader"}`, async () => {
      const response = await f.call(token, f.sessions[visibility], f.visuals[`${visibility}:ready`], true);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(response.headers.get("content-type"), "image/png");
      assert.equal(response.headers.get("content-length"), String(png.length));
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
      assert.deepEqual(await f.state(), before); assert.equal(calls, 0);
    });
    delete process.env.CHRONICLE_VISUALS_DISABLED;
    process.env.POLLINATIONS_API_KEY = "synthetic-visual-key";
    for (const [session, visual, retry, status, code] of [
      [f.sessions.public, f.visuals["public:pending"], false, 403, "VISUAL_NOT_READY"],
      [f.sessions.public, f.visuals["public:failed"], true, 403, "VISUAL_NOT_READY"],
      [f.sessions.private, f.visuals["private:ready"], false, 404, "NOT_FOUND"],
      [f.sessions.public, f.visuals["private:ready"], false, 404, "NOT_FOUND"],
    ] as const) await t.test(`reader ${status} ${code} retry=${retry}`, async () => {
      const response = await f.call(readerToken, session, visual, retry);
      assert.equal(response.status, status); assert.equal((await response.json()).code, code);
      if (session === f.sessions.public) assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.deepEqual(await f.state(), before); assert.equal(calls, 0);
    });
    const wrongCampaign = await f.call(ownerToken, f.sessions.public, f.visuals["private:pending"]);
    assert.equal(wrongCampaign.status, 404); assert.equal((await wrongCampaign.json()).code, "NOT_FOUND");
    const refusedDelete = await f.call(readerToken, f.sessions.public, f.visuals["public:ready"], false, "DELETE");
    assert.equal(refusedDelete.status, 404); assert.equal((await refusedDelete.json()).code, "NOT_FOUND");
    assert.deepEqual(await f.state(), before); assert.equal(calls, 0);
    for (const status of ["pending", "failed"]) {
      const visual = f.visuals[`private:${status}`];
      await f.pg.query("UPDATE scene_visuals SET attempts=4,updated_at=now()-interval '2 minutes' WHERE id=$1", [visual]);
      const exhausted = await f.state();
      const response = await f.call(ownerToken, f.sessions.private, visual, true);
      assert.equal(response.status, 502); assert.equal((await response.json()).code, "VISUAL_FAILED");
      assert.equal(calls, 0); assert.deepEqual(await f.state(), exhausted);
    }
  } finally {
    transport.mock.restore();
    if (oldKey === undefined) delete process.env.POLLINATIONS_API_KEY; else process.env.POLLINATIONS_API_KEY = oldKey;
    if (oldDisabled === undefined) delete process.env.CHRONICLE_VISUALS_DISABLED; else process.env.CHRONICLE_VISUALS_DISABLED = oldDisabled;
    await f.close();
  }
});

// Skipping the real generation or retry, incrementing twice, changing the seed,
// or charging another reservation must fail these response and SQL assertions.
test("actual owner image GET generates pending and explicitly retried failed rows then public reads cached bytes", async () => {
  const f = await fixture();
  let calls = 0;
  const oldKey = process.env.POLLINATIONS_API_KEY;
  const transport = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin, "https://gen.pollinations.ai");
    assert.equal(decodeURIComponent(url.pathname), "/image/Синтетический портрет");
    assert.deepEqual(Object.fromEntries(url.searchParams), { model: "fixture-model", width: "768", height: "960", seed: "42", safe: "true" });
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-visual-key");
    assert.equal(init?.cache, "no-store");
    return new Response(png, { headers: { "content-type": "image/png" } });
  });
  try {
    process.env.POLLINATIONS_API_KEY = "synthetic-visual-key";
    const before = await f.state();
    for (const [status, expectedAttempts] of [["pending", 1], ["failed", 2]] as const) {
      const visual = f.visuals[`public:${status}`];
      const old = before.visuals.find(row => row.id === visual)!;
      const response = await f.call(ownerToken, f.sessions.public, visual, status === "failed");
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
      const row = (await f.pg.query<StoredVisual>("SELECT * FROM scene_visuals WHERE id=$1", [visual])).rows[0];
      assert.ok(row.updated_at instanceof Date); assert.ok(row.updated_at.getTime() >= old.updated_at.getTime());
      assert.equal(typeof row.latency_ms, "number"); assert.ok(row.latency_ms !== null && row.latency_ms >= 0);
      assert.deepEqual(row, { ...old, status: "ready", attempts: expectedAttempts, error: null, image: new Uint8Array(png), mime_type: "image/png", latency_ms: row.latency_ms, updated_at: row.updated_at });
      const reader = await f.call(readerToken, f.sessions.public, visual, true);
      assert.equal(reader.status, 200); assert.deepEqual(Buffer.from(await reader.arrayBuffer()), png);
    }
    assert.equal(calls, 2);
    const after = await f.state();
    assert.deepEqual(after.ledger, before.ledger); assert.deepEqual(after.sessions, before.sessions);
    assert.deepEqual(after.identities, before.identities); assert.deepEqual(after.activity, []);
    for (const row of before.visuals.filter(row => ![f.visuals["public:pending"], f.visuals["public:failed"]].includes(String(row.id))))
      assert.deepEqual(after.visuals.find(saved => saved.id === row.id), row);
  } finally {
    transport.mock.restore();
    if (oldKey === undefined) delete process.env.POLLINATIONS_API_KEY; else process.env.POLLINATIONS_API_KEY = oldKey;
    await f.close();
  }
});
