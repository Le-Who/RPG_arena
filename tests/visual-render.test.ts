import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { HttpError } from "../src/lib/http";

test("renderVisual persists safe error codes and does not expose arbitrary provider exception", async () => {
  const fixture = await accountsDb(); const oldFetch = global.fetch, oldKey = process.env.POLLINATIONS_API_KEY;
  try {
    process.env.POLLINATIONS_API_KEY = "VISUAL_KEY_SENTINEL";
    const session = randomUUID();
    await fixture.pg.query(`INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,'OWNER_SENTINEL','Fixture','{"name":"Анна","archetype":"писатель","appearance":"тёмные волосы"}','{"worldName":"Город","tone":"быт","era":"сегодня","currentLocation":"Кафе"}')`, [session]);
    const { createVisual, renderVisual } = await import("../src/lib/visuals");
    const visual = await createVisual(session, { kind: "portrait", subject: "hero" });
    global.fetch = async () => { throw new Error("PROVIDER_HTTP_401: VISUAL_KEY_SENTINEL BODY_SECRET_SENTINEL"); };
    await assert.rejects(() => renderVisual(session, visual.id), error => error instanceof HttpError && error.status === 502 && error.code === "VISUAL_FAILED" && !/SENTINEL/.test(error.message));
    const stored = (await fixture.pg.query<{ status: string; error: string; attempts: number }>("SELECT status,error,attempts FROM scene_visuals WHERE id=$1", [visual.id])).rows[0];
    assert.deepEqual(stored, { status: "failed", error: "PROVIDER_ERROR", attempts: 1 });
    // Previously persisted errors must not escape through the failed-row fast path either.
    await fixture.pg.query("UPDATE scene_visuals SET error='LEGACY_SECRET_SENTINEL' WHERE id=$1", [visual.id]);
    await assert.rejects(() => renderVisual(session, visual.id), error => error instanceof HttpError && !/SENTINEL/.test(error.message));
  } finally { global.fetch = oldFetch; if (oldKey === undefined) delete process.env.POLLINATIONS_API_KEY; else process.env.POLLINATIONS_API_KEY = oldKey; await fixture.close(); }
});

test("production visual request excludes service metadata while preserving authored scene UUID and names", async () => {
  const fixture = await accountsDb(); const oldFetch = global.fetch, oldKey = process.env.POLLINATIONS_API_KEY;
  try {
    process.env.POLLINATIONS_API_KEY = "VISUAL_KEY_SENTINEL";
    const session = "11111111-1111-4111-8111-111111111111", turn = "22222222-2222-4222-8222-222222222222", authored = "33333333-3333-4333-8333-333333333333";
    await fixture.pg.query(`INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,'OWNER_SENTINEL','SERVICE_TITLE_SENTINEL','{"name":"Анна","archetype":"писатель","appearance":"тёмные волосы"}','{"worldName":"Город","tone":"быт","era":"сегодня","currentLocation":"Кафе"}')`, [session]);
    await fixture.pg.query("INSERT INTO game_turns(id,session_id,role,content,turn_number) VALUES ($1,$2,'narrator',$3,1)", [turn, session, `Анна записала код ${authored} в блокнот.`]);
    const { createVisual, renderVisual } = await import("../src/lib/visuals");
    const visual = await createVisual(session, { kind: "scene", turnNumber: 1 });
    let sent = "";
    global.fetch = async url => { sent = decodeURIComponent(String(url)); return new Response(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==", "base64"), { headers: { "Content-Type": "image/png" } }); };
    const result = await renderVisual(session, visual.id);
    assert.equal(result.mimeType, "image/png"); assert.ok(result.image.length > 0);
    for (const metadata of [session, turn, visual.id, "OWNER_SENTINEL", "SERVICE_TITLE_SENTINEL", "VISUAL_KEY_SENTINEL"]) assert.ok(!sent.includes(metadata), `service metadata leaked: ${metadata}`);
    assert.ok(sent.includes(authored)); assert.ok(sent.includes("Анна"));
    assert.equal((await fixture.pg.query<{ status: string }>("SELECT status FROM scene_visuals WHERE id=$1", [visual.id])).rows[0].status, "ready");
  } finally { global.fetch = oldFetch; if (oldKey === undefined) delete process.env.POLLINATIONS_API_KEY; else process.env.POLLINATIONS_API_KEY = oldKey; await fixture.close(); }
});

test("owner and public gallery GET sanitize legacy stored visual errors before response projection", async () => {
  const fixture = await accountsDb();
  try {
    const { profileIdFromToken } = await import("../src/lib/guest-identity");
    const { GET } = await import("../src/app/api/sessions/[id]/visuals/route");
    const ownerToken = "a".repeat(64), readerToken = "b".repeat(64), session = randomUUID(), visual = randomUUID();
    await fixture.pg.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state,visibility) VALUES ($1,$2,'Gallery','{}','{}','public')", [session, profileIdFromToken(ownerToken)]);
    await fixture.pg.query(`INSERT INTO scene_visuals(id,session_id,owner_id,kind,subject_key,caption,prompt,provider,model,seed,width,height,status,error)
      VALUES ($1,$2,$3,'portrait','hero','Портрет','Описание','pollinations','fixture',1,768,960,'failed','LEGACY_PROVIDER_SECRET_SENTINEL')`, [visual, session, profileIdFromToken(ownerToken)]);
    for (const token of [ownerToken, readerToken]) {
      const response = await cookieContext(`chronicle_guest=${token}`, () => GET(new Request(`https://example.test/api/sessions/${session}/visuals`), { params: Promise.resolve({ id: session }) }));
      assert.equal(response.status, 200);
      const body = await response.text(); assert.doesNotMatch(body, /LEGACY_PROVIDER_SECRET_SENTINEL/);
      const payload = JSON.parse(body); assert.equal(payload.visuals[0].id, visual); assert.equal(payload.visuals[0].status, "failed");
      assert.equal(payload.visuals[0].error, "Провайдер не вернул изображение. Попробуйте повторить генерацию.");
    }
    // Display cleanup is read-only: the old row is preserved for a separate explicit migration policy.
    assert.equal((await fixture.pg.query<{ error: string }>("SELECT error FROM scene_visuals WHERE id=$1", [visual])).rows[0].error, "LEGACY_PROVIDER_SECRET_SENTINEL");
  } finally { await fixture.close(); }
});

test("disabled visual generation rejects pending and failed retry without state or quota changes, retaining cached images", async t => {
  const fixture = await accountsDb();
  const oldFetch = global.fetch, oldKey = process.env.POLLINATIONS_API_KEY, oldDisabled = process.env.CHRONICLE_VISUALS_DISABLED;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==", "base64");
  try {
    process.env.POLLINATIONS_API_KEY = "DISABLED_VISUAL_KEY_SENTINEL";
    delete process.env.CHRONICLE_VISUALS_DISABLED;
    const session = randomUUID();
    await fixture.pg.query(`INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,'disabled-visual-owner','Fixture','{"name":"Анна","archetype":"писатель","appearance":"тёмные волосы"}','{"worldName":"Город","tone":"быт","era":"сегодня","currentLocation":"Кафе"}')`, [session]);
    const { createVisual, renderVisual, listVisuals } = await import("../src/lib/visuals");
    const pending = await createVisual(session, { kind: "portrait", subject: "hero" });
    const failed = await createVisual(session, { kind: "portrait", subject: "hero" });
    const ready = await createVisual(session, { kind: "portrait", subject: "hero" });
    await fixture.pg.query("UPDATE scene_visuals SET status='failed',attempts=2,error='PROVIDER_HTTP_503' WHERE id=$1", [failed.id]);
    let fetches = 0;
    global.fetch = async () => { fetches++; return new Response(png, { headers: { "Content-Type": "image/png" } }); };
    assert.deepEqual(await renderVisual(session, ready.id), { image: png, mimeType: "image/png" });
    assert.equal(fetches, 1);
    process.env.CHRONICLE_VISUALS_DISABLED = "1";
    const gallery = await listVisuals(session);
    assert.equal(gallery.config.enabled, false); assert.equal(gallery.config.authenticated, true);
    const reservationsBefore = (await fixture.pg.query("SELECT quota_scope,visual_id,created_at FROM visual_quota_reservations ORDER BY visual_id")).rows;
    assert.equal(reservationsBefore.length, 3);
    for (const [visual, expected] of [
      [pending, { status: "pending", attempts: 0, error: null }],
      [failed, { status: "failed", attempts: 2, error: "PROVIDER_HTTP_503" }],
    ] as const) await t.test(expected.status, async () => {
      fetches = 0;
      const before = (await fixture.pg.query("SELECT status,attempts,error,updated_at,image,mime_type FROM scene_visuals WHERE id=$1", [visual.id])).rows[0];
      let rejection: unknown;
      try { await renderVisual(session, visual.id, { retry: true, allowGenerate: true }); } catch (error) { rejection = error; }
      const after = (await fixture.pg.query<{ status: string; attempts: number; error: string | null }>("SELECT status,attempts,error,updated_at,image,mime_type FROM scene_visuals WHERE id=$1", [visual.id])).rows[0];
      assert.deepEqual({ code: rejection instanceof HttpError ? rejection.code : null, httpStatus: rejection instanceof HttpError ? rejection.status : null, fetches, status: after.status, attempts: after.attempts, error: after.error }, { code: "VISUALS_DISABLED", httpStatus: 503, fetches: 0, ...expected });
      assert.deepEqual(after, before);
      assert.ok(rejection instanceof HttpError); assert.doesNotMatch(rejection.message, /SENTINEL/);
    });
    await t.test("cached ready image", async () => {
      fetches = 0;
      const saved = await renderVisual(session, ready.id, { retry: true, allowGenerate: true });
      assert.deepEqual(Buffer.from(saved.image), png); assert.equal(saved.mimeType, "image/png"); assert.equal(fetches, 0);
      assert.deepEqual((await fixture.pg.query("SELECT status,attempts FROM scene_visuals WHERE id=$1", [ready.id])).rows[0], { status: "ready", attempts: 1 });
    });
    assert.deepEqual((await fixture.pg.query("SELECT quota_scope,visual_id,created_at FROM visual_quota_reservations ORDER BY visual_id")).rows, reservationsBefore);
  } finally {
    global.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.POLLINATIONS_API_KEY; else process.env.POLLINATIONS_API_KEY = oldKey;
    if (oldDisabled === undefined) delete process.env.CHRONICLE_VISUALS_DISABLED; else process.env.CHRONICLE_VISUALS_DISABLED = oldDisabled;
    await fixture.close();
  }
});
