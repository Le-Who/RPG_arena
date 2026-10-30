import test from "node:test";
import assert from "node:assert/strict";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { profileIdFromToken } from "../src/lib/guest-identity";

const sessionId = "75000000-0000-4000-8000-000000000001";
const missingSessionId = "75000000-0000-4000-8000-000000000002";
const ownerToken = "d".repeat(64);

test("polling before admission is a normal state while missing or foreign campaigns stay inaccessible", async () => {
  const f = await accountsDb();
  try {
    const { GET } = await import("../src/app/api/sessions/[id]/requests/[requestId]/route");
    await f.pg.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state,turn_count) VALUES ($1,$2,'Встреча','{}','{}',1)", [sessionId, profileIdFromToken(ownerToken)]);
    const poll = (id = sessionId, token = ownerToken) => cookieContext(`chronicle_guest=${token}`, () => GET(
      new Request(`https://game.test/api/sessions/${id}/requests/new-request`),
      { params: Promise.resolve({ id, requestId: "new-request" }) },
    ));

    const waiting = await poll();
    assert.equal(waiting.status, 200, "a poll can arrive before its POST has created the request ledger row");
    assert.deepEqual(await waiting.json(), { requestId: "new-request", status: "not_accepted" });
    assert.equal(waiting.headers.get("cache-control"), "private, no-store");
    assert.deepEqual((await f.pg.query("SELECT request_id FROM turn_requests")).rows, [], "polling must not admit a turn");

    for (const response of [await poll(missingSessionId), await poll(sessionId, "e".repeat(64))]) {
      assert.equal(response.status, 404);
      assert.equal((await response.json()).code, "NOT_FOUND");
    }

    await f.pg.query("INSERT INTO turn_requests(session_id,request_id,input_hash,action,is_free,base_turn,status,stage,error) VALUES ($1,'new-request','fixture','Осмотреться',true,1,'failed','failed','AI_REQUIRED')", [sessionId]);
    const admitted = await poll();
    assert.equal(admitted.status, 200);
    assert.deepEqual(await admitted.json(), { requestId: "new-request", status: "failed", stage: "failed", baseTurn: 1, retryAfter: 0, error: "AI_REQUIRED", result: null });
  } finally { await f.close(); }
});
