import test from "node:test";
import assert from "node:assert/strict";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { profileIdFromToken } from "../src/lib/guest-identity";
import { sealSecret, secretContext } from "../src/lib/secret-vault";

test("compaction background tick cannot spend a new owner's provider connection after adoption", async t => {
  const fixture = await accountsDb();
  process.env.CHRONICLE_SECRET_ACTIVE_KEY = "compact";
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ compact: Buffer.alloc(32, 37).toString("base64") });
  try {
    const { POST } = await import("../src/app/api/sessions/[id]/compact/route");
    const { auth } = await import("../src/lib/auth");
    const guest = "5".repeat(64), original = profileIdFromToken(guest)!;
    const target = await auth.register("4".repeat(64), "compact-new-owner", "correct horse battery staple");
    const owner = target.identity.profileId;
    const session = "00000000-0000-4000-8000-000000000017";
    await fixture.pg.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state,turn_count) VALUES ($1,$2,'Story','{}','{}',1)", [session, original]);
    await fixture.pg.query("INSERT INTO game_turns(session_id,turn_number,role,content) VALUES ($1,1,'narrator','Анна встретила подругу у входа в кафе.')", [session]);
    const jobs: (() => Promise<void>)[] = [];
    const response = await cookieContext(`chronicle_guest=${guest}`, () => POST(new Request(`https://game.test/api/sessions/${session}/compact`, { method: "POST" }), { params: Promise.resolve({ id: session }) }), jobs);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).created, 1);
    assert.equal(jobs.length, 1);
    await auth.adopt(guest, target.sessionToken);
    await fixture.pg.query("INSERT INTO ai_settings(id,keys,embedding_dims,embeddings_enabled) VALUES ($1,$2,768,true)", [owner, [sealSecret("synthetic-new-owner-key", secretContext(owner, "gemini"))]]);
    let providerCalls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      providerCalls++;
      return Response.json({ embedding: { values: [1, ...Array<number>(767).fill(0)] } });
    });
    await jobs[0]();
    assert.equal(providerCalls, 0);
    assert.equal((await fixture.pg.query<{ n: number }>("SELECT count(*)::int AS n FROM model_call_quotas WHERE owner_id=$1", [owner])).rows[0].n, 0);
    assert.equal((await fixture.pg.query<{ n: number }>("SELECT count(*)::int AS n FROM owner_activity")).rows[0].n, 0);
  } finally {
    delete process.env.CHRONICLE_SECRET_ACTIVE_KEY; delete process.env.CHRONICLE_SECRET_KEYS;
    await fixture.close();
  }
});
