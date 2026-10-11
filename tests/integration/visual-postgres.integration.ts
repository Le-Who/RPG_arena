import "../helpers/test-environment";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cookieContext } from "../helpers/accounts-db";
import { boundedVisual, visualBarrier, visualPostgresFixture } from "../helpers/visual-postgres-fixture";
import { profileIdFromToken } from "../../src/lib/guest-identity";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==", "base64");
const ownerToken = "a".repeat(64), owner = profileIdFromToken(ownerToken)!;

for (const outcome of ["success", "failure"] as const) test(`native initial image GETs across web instances share ${outcome} and preserve the reservation`, {
  skip: process.env.CHRONICLE_RUN_VISUAL_POSTGRES !== "1", timeout: 45000,
}, async () => {
  const fixture = await visualPostgresFixture();
  const gate = visualBarrier(), secondRead = visualBarrier();
  let calls = 0;
  const oldKey = process.env.POLLINATIONS_API_KEY;
  const transport = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    calls++;
    if (calls === 2) secondRead.release();
    const url = new URL(String(input));
    assert.equal(url.origin, "https://gen.pollinations.ai");
    assert.equal(decodeURIComponent(url.pathname), "/image/Синтетический портрет");
    assert.deepEqual(Object.fromEntries(url.searchParams), { model: "fixture-model", width: "768", height: "960", seed: "42", safe: "true" });
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-visual-key");
    await gate.hold();
    if (outcome === "failure") throw new Error("synthetic visual provider failure");
    return new Response(png, { headers: { "content-type": "image/png" } });
  });
  let requests: Promise<Response>[] = [];
  try {
    process.env.POLLINATIONS_API_KEY = "synthetic-visual-key";
    const session = randomUUID(), visual = randomUUID();
    await fixture.control.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,$2,'Visual fixture','{}','{}')", [session, owner]);
    await fixture.control.query(`INSERT INTO scene_visuals(id,session_id,owner_id,kind,subject_key,caption,prompt,provider,model,seed,width,height)
      VALUES ($1,$2,$3,'portrait','hero','Портрет','Синтетический портрет','pollinations','fixture-model',42,768,960)`, [visual, session, owner]);
    await fixture.control.query("INSERT INTO visual_quota_reservations(quota_scope,visual_id) VALUES ($1,$2)", [`owner:${owner}`, visual]);
    const ledger = (await fixture.control.query("SELECT * FROM visual_quota_reservations")).rows;
    const initial = (await fixture.control.query("SELECT * FROM scene_visuals WHERE id=$1", [visual])).rows[0];
    const sessionBefore = (await fixture.control.query("SELECT * FROM game_sessions")).rows;
    const first = await fixture.imageRoute();
    let secondVisualReads = 0;
    const second = await fixture.imageRoute(async (sql, phase) => {
      if (phase === "after" && sql.startsWith("select") && sql.includes('from "scene_visuals"') && ++secondVisualReads >= 3) secondRead.release();
    });
    const firstPid = (await first.pool.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    const secondPid = (await second.pool.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    assert.notEqual(firstPid, secondPid);
    const request = (route: typeof first.route) => cookieContext(`chronicle_guest=${ownerToken}`, () => route.GET(new Request(`https://game.test/api/sessions/${session}/visuals/${visual}`), { params: Promise.resolve({ id: session, visualId: visual }) }));
    requests = [request(first.route)];
    await boundedVisual(gate.entered, "first provider started");
    // The irreversible call must already be charged, even if its process dies.
    assert.deepEqual((await fixture.control.query("SELECT status,attempts,image,mime_type FROM scene_visuals WHERE id=$1", [visual])).rows,
      [{ status: "pending", attempts: 1, image: null, mime_type: null }]);
    assert.deepEqual((await fixture.control.query("SELECT state FROM pg_stat_activity WHERE pid=$1", [firstPid])).rows, [{ state: "idle" }]);
    assert.equal(first.pool.idleCount, first.pool.totalCount, "provider IO cannot hold a pool connection");
    requests.push(request(second.route));
    // The second handler must reach persisted waiting (another row read) or the
    // forbidden duplicate provider call while the first provider stays gated.
    await boundedVisual(secondRead.hold(), "second handler waits on pending row");
    assert.equal(calls, 1, "a pending lease must prevent a duplicate provider call");
    gate.release();
    const responses = await boundedVisual(Promise.all(requests), "initial image responses");
    for (const response of responses) {
      assert.equal(response.status, outcome === "success" ? 200 : 502, await response.clone().text());
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      if (outcome === "success") assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
      else assert.equal((await response.json()).code, "VISUAL_FAILED");
    }
    assert.equal(calls, 1, "one visual must cause exactly one provider request across instances");
    const saved = (await fixture.control.query("SELECT * FROM scene_visuals WHERE id=$1", [visual])).rows[0];
    assert.ok(saved.updated_at instanceof Date); assert.ok(saved.updated_at.getTime() >= initial.updated_at.getTime());
    assert.equal(typeof saved.latency_ms, "number"); assert.ok(saved.latency_ms >= 0);
    assert.deepEqual(saved, { ...initial, status: outcome === "success" ? "ready" : "failed", attempts: 1,
      error: outcome === "success" ? null : "PROVIDER_ERROR", image: outcome === "success" ? png : null,
      mime_type: outcome === "success" ? "image/png" : null, latency_ms: saved.latency_ms, updated_at: saved.updated_at });
    assert.deepEqual((await fixture.control.query("SELECT * FROM visual_quota_reservations")).rows, ledger);
    assert.deepEqual((await fixture.control.query("SELECT * FROM game_sessions")).rows, sessionBefore);
    assert.deepEqual((await fixture.control.query("SELECT * FROM owner_activity")).rows, []);
  } finally {
    gate.release(); secondRead.release(); await Promise.allSettled(requests);
    transport.mock.restore();
    if (oldKey === undefined) delete process.env.POLLINATIONS_API_KEY; else process.env.POLLINATIONS_API_KEY = oldKey;
    await fixture.close();
  }
});

// Removing the atomic attempt/status claim predicate must allow both handlers
// to send an irreversible call after they have both observed attempts=0.
test("native simultaneous pending-row claims admit only one provider call", {
  skip: process.env.CHRONICLE_RUN_VISUAL_POSTGRES !== "1", timeout: 45000,
}, async () => {
  const fixture = await visualPostgresFixture();
  const firstClaim = visualBarrier(), secondClaim = visualBarrier(), providerGate = visualBarrier();
  const oldKey = process.env.POLLINATIONS_API_KEY;
  let calls = 0;
  const transport = mock.method(globalThis, "fetch", async () => {
    calls++; await providerGate.hold();
    return new Response(png, { headers: { "content-type": "image/png" } });
  });
  const requests: Promise<Response>[] = [];
  try {
    process.env.POLLINATIONS_API_KEY = "synthetic-visual-key";
    const session = randomUUID(), visual = randomUUID();
    await fixture.control.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,$2,'Claim fixture','{}','{}')", [session, owner]);
    await fixture.control.query(`INSERT INTO scene_visuals(id,session_id,owner_id,kind,subject_key,caption,prompt,provider,model,seed,width,height)
      VALUES ($1,$2,$3,'portrait','hero','Портрет','Синтетический портрет','pollinations','fixture-model',42,768,960)`, [visual, session, owner]);
    await fixture.control.query("INSERT INTO visual_quota_reservations(quota_scope,visual_id) VALUES ($1,$2)", [`owner:${owner}`, visual]);
    const ledger = (await fixture.control.query("SELECT * FROM visual_quota_reservations")).rows;
    const before = (await fixture.control.query("SELECT * FROM scene_visuals")).rows[0];
    const makeRoute = (gate: ReturnType<typeof visualBarrier>) => {
      let held = false;
      return fixture.imageRoute(async (sql, phase) => {
        if (!held && phase === "before" && sql.startsWith('update "scene_visuals"')) {
          held = true; await gate.hold();
        }
      });
    };
    const first = await makeRoute(firstClaim), second = await makeRoute(secondClaim);
    assert.notEqual((await first.pool.query("SELECT pg_backend_pid() pid")).rows[0].pid, (await second.pool.query("SELECT pg_backend_pid() pid")).rows[0].pid);
    const request = (route: typeof first.route) => cookieContext(`chronicle_guest=${ownerToken}`, () => route.GET(new Request(`https://game.test/api/sessions/${session}/visuals/${visual}`), { params: Promise.resolve({ id: session, visualId: visual }) }));
    requests.push(request(first.route)); await boundedVisual(firstClaim.entered, "first read attempts zero");
    requests.push(request(second.route)); await boundedVisual(secondClaim.entered, "second read attempts zero");
    assert.deepEqual((await fixture.control.query("SELECT status,attempts FROM scene_visuals")).rows, [{ status: "pending", attempts: 0 }]);
    firstClaim.release(); secondClaim.release();
    await boundedVisual(providerGate.entered, "winner reached provider");
    providerGate.release();
    for (const response of await boundedVisual(Promise.all(requests), "both claim responses")) {
      assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    }
    assert.equal(calls, 1);
    const saved = (await fixture.control.query("SELECT * FROM scene_visuals")).rows[0];
    assert.equal(typeof saved.latency_ms, "number"); assert.ok(saved.latency_ms >= 0);
    assert.ok(saved.updated_at.getTime() >= before.updated_at.getTime());
    assert.deepEqual(saved, { ...before, attempts: 1, status: "ready", image: png, mime_type: "image/png", error: null, updated_at: saved.updated_at, latency_ms: saved.latency_ms });
    assert.deepEqual((await fixture.control.query("SELECT * FROM visual_quota_reservations")).rows, ledger);
    assert.deepEqual((await fixture.control.query("SELECT * FROM owner_activity")).rows, []);
  } finally {
    firstClaim.release(); secondClaim.release(); providerGate.release(); await Promise.allSettled(requests);
    transport.mock.restore();
    if (oldKey === undefined) delete process.env.POLLINATIONS_API_KEY; else process.env.POLLINATIONS_API_KEY = oldKey;
    await fixture.close();
  }
});

// A stale provider error must not overwrite a newer attempt's committed image.
test("native expired visual lease can recover with an attempt fence against stale completion", {
  skip: process.env.CHRONICLE_RUN_VISUAL_POSTGRES !== "1", timeout: 45000,
}, async () => {
  const fixture = await visualPostgresFixture();
  const staleProvider = visualBarrier();
  const oldKey = process.env.POLLINATIONS_API_KEY;
  let calls = 0;
  const transport = mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1) { await staleProvider.hold(); throw new Error("synthetic stale provider failure"); }
    return new Response(png, { headers: { "content-type": "image/png" } });
  });
  const requests: Promise<Response>[] = [];
  try {
    process.env.POLLINATIONS_API_KEY = "synthetic-visual-key";
    const session = randomUUID(), visual = randomUUID();
    await fixture.control.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,$2,'Expired fixture','{}','{}')", [session, owner]);
    await fixture.control.query(`INSERT INTO scene_visuals(id,session_id,owner_id,kind,subject_key,caption,prompt,provider,model,seed,width,height)
      VALUES ($1,$2,$3,'portrait','hero','Портрет','Синтетический портрет','pollinations','fixture-model',42,768,960)`, [visual, session, owner]);
    await fixture.control.query("INSERT INTO visual_quota_reservations(quota_scope,visual_id) VALUES ($1,$2)", [`owner:${owner}`, visual]);
    const ledger = (await fixture.control.query("SELECT * FROM visual_quota_reservations")).rows;
    const first = await fixture.imageRoute(), second = await fixture.imageRoute();
    const call = (route: typeof first.route) => cookieContext(`chronicle_guest=${ownerToken}`, () => route.GET(new Request(`https://game.test/api/sessions/${session}/visuals/${visual}`), { params: Promise.resolve({ id: session, visualId: visual }) }));
    requests.push(call(first.route)); await boundedVisual(staleProvider.entered, "stale provider paused");
    assert.deepEqual((await fixture.control.query("SELECT status,attempts,image,mime_type FROM scene_visuals")).rows, [{ status: "pending", attempts: 1, image: null, mime_type: null }]);
    // Advance only the owned fixture's persisted lease; no permission/provider verdict is mocked.
    await fixture.control.query("UPDATE scene_visuals SET updated_at=now()-interval '2 minutes' WHERE id=$1", [visual]);
    requests.push(call(second.route));
    const recovered = await boundedVisual(requests[1], "expired lease recovery");
    assert.equal(recovered.status, 200); assert.deepEqual(Buffer.from(await recovered.arrayBuffer()), png);
    const committed = (await fixture.control.query("SELECT * FROM scene_visuals")).rows;
    assert.deepEqual(committed.map(row => ({ status: row.status, attempts: row.attempts, error: row.error, image: row.image, mime_type: row.mime_type })), [{ status: "ready", attempts: 2, error: null, image: png, mime_type: "image/png" }]);
    staleProvider.release();
    const stale = await boundedVisual(requests[0], "stale failure finishes");
    assert.equal(stale.status, 502); assert.equal((await stale.json()).code, "VISUAL_FAILED");
    assert.deepEqual((await fixture.control.query("SELECT * FROM scene_visuals")).rows, committed);
    const cached = await call(second.route);
    assert.equal(cached.status, 200); assert.deepEqual(Buffer.from(await cached.arrayBuffer()), png);
    assert.equal(calls, 2); assert.deepEqual((await fixture.control.query("SELECT * FROM visual_quota_reservations")).rows, ledger);
    assert.deepEqual((await fixture.control.query("SELECT * FROM owner_activity")).rows, []);
  } finally {
    staleProvider.release(); await Promise.allSettled(requests);
    transport.mock.restore();
    if (oldKey === undefined) delete process.env.POLLINATIONS_API_KEY; else process.env.POLLINATIONS_API_KEY = oldKey;
    await fixture.close();
  }
});

for (const outcome of ["success", "failure"] as const) test(`native owner DELETE during ${outcome} render never resurrects an image or reservation`, {
  skip: process.env.CHRONICLE_RUN_VISUAL_POSTGRES !== "1", timeout: 45000,
}, async () => {
  const fixture = await visualPostgresFixture();
  const providerGate = visualBarrier(), deleteIssued = visualBarrier();
  let calls = 0;
  const oldKey = process.env.POLLINATIONS_API_KEY;
  const events: string[] = [];
  const transport = mock.method(globalThis, "fetch", async () => {
    calls++; events.push("provider-start");
    await providerGate.hold(); events.push("provider-complete");
    if (outcome === "failure") throw new Error("synthetic visual provider failure");
    return new Response(png, { headers: { "content-type": "image/png" } });
  });
  const requests: Promise<Response>[] = [];
  try {
    process.env.POLLINATIONS_API_KEY = "synthetic-visual-key";
    const session = randomUUID(), visual = randomUUID(), retained = randomUUID();
    await fixture.control.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,$2,'Deletion fixture','{}','{}')", [session, owner]);
    for (const id of [visual, retained]) {
      await fixture.control.query(`INSERT INTO scene_visuals(id,session_id,owner_id,kind,subject_key,caption,prompt,provider,model,seed,width,height)
        VALUES ($1,$2,$3,'portrait','hero','Портрет','Синтетический портрет','pollinations','fixture-model',42,768,960)`, [id, session, owner]);
      await fixture.control.query("INSERT INTO visual_quota_reservations(quota_scope,visual_id) VALUES ($1,$2)", [`owner:${owner}`, id]);
    }
    await fixture.control.query("INSERT INTO visual_identities(session_id,subject_key,subject_name,passport,seed,reference_visual_id) VALUES ($1,'hero','Анна','Тёмные волосы',42,$2)", [session, visual]);
    const ledger = (await fixture.control.query("SELECT * FROM visual_quota_reservations ORDER BY id")).rows;
    const sessions = (await fixture.control.query("SELECT * FROM game_sessions")).rows;
    const retainedRow = (await fixture.control.query("SELECT * FROM scene_visuals WHERE id=$1", [retained])).rows;
    const identity = (await fixture.control.query("SELECT * FROM visual_identities")).rows[0];
    const rendering = await fixture.imageRoute();
    const deleting = await fixture.imageRoute(async (sql, phase) => {
      if (phase === "before" && sql.startsWith('delete from "scene_visuals"')) {
        events.push("delete-issued"); deleteIssued.release();
      }
    });
    assert.notEqual((await rendering.pool.query("SELECT pg_backend_pid() pid")).rows[0].pid, (await deleting.pool.query("SELECT pg_backend_pid() pid")).rows[0].pid);
    const call = (route: typeof rendering.route, method: "GET" | "DELETE") => cookieContext(`chronicle_guest=${ownerToken}`, () => route[method](new Request(`https://game.test/api/sessions/${session}/visuals/${visual}`, { method }), { params: Promise.resolve({ id: session, visualId: visual }) }));
    requests.push(call(rendering.route, "GET"));
    await boundedVisual(providerGate.entered, "render provider entered");
    requests.push(call(deleting.route, "DELETE"));
    await boundedVisual(deleteIssued.hold(), "owner deletion issued before provider completion");
    const deletion = await boundedVisual(requests[1], "deletion commits while provider is still gated");
    assert.equal(deletion.status, 200);
    assert.deepEqual((await fixture.control.query("SELECT * FROM scene_visuals WHERE id=$1", [visual])).rows, []);
    assert.deepEqual(events, ["provider-start", "delete-issued"]);
    providerGate.release();
    const [rendered, deleted] = await boundedVisual(Promise.all(requests), "render and deletion complete");
    assert.equal(rendered.status, outcome === "success" ? 200 : 502);
    if (outcome === "success") assert.deepEqual(Buffer.from(await rendered.arrayBuffer()), png);
    else assert.equal((await rendered.json()).code, "VISUAL_FAILED");
    assert.equal(deleted.status, 200); assert.deepEqual(await deleted.json(), { ok: true });
    assert.deepEqual(events, ["provider-start", "delete-issued", "provider-complete"]);
    assert.deepEqual((await fixture.control.query("SELECT * FROM scene_visuals WHERE id=$1", [visual])).rows, []);
    assert.deepEqual((await fixture.control.query("SELECT * FROM scene_visuals")).rows, retainedRow);
    assert.deepEqual((await fixture.control.query("SELECT * FROM visual_quota_reservations ORDER BY id")).rows, ledger);
    assert.deepEqual((await fixture.control.query("SELECT * FROM game_sessions")).rows, sessions);
    assert.deepEqual((await fixture.control.query("SELECT * FROM visual_identities")).rows, [{ ...identity, reference_visual_id: null }]);
    const reread = await call(rendering.route, "GET");
    assert.equal(reread.status, 404); assert.equal((await reread.json()).code, "NOT_FOUND");
    assert.equal(calls, 1); assert.deepEqual((await fixture.control.query("SELECT * FROM owner_activity")).rows, []);
    assert.deepEqual((await fixture.control.query("SELECT * FROM visual_quota_reservations ORDER BY id")).rows, ledger);
  } finally {
    providerGate.release(); deleteIssued.release(); await Promise.allSettled(requests);
    transport.mock.restore();
    if (oldKey === undefined) delete process.env.POLLINATIONS_API_KEY; else process.env.POLLINATIONS_API_KEY = oldKey;
    await fixture.close();
  }
});
