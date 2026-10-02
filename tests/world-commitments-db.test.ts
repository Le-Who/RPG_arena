import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { portableFixture } from "./helpers/portable-fixture";
import { newGuestToken, profileIdFromToken } from "../src/lib/guest-identity";
import { commitmentVersion } from "../src/lib/world-commitments";
import type { Commitment } from "../src/lib/world-life";
import type { WorldState } from "../src/db/schema";

test("owner commitment route protects ownership, stale versions, leases and atomic memory writes", async () => {
  const fixture = await accountsDb();
  try {
    const token = newGuestToken(), stranger = newGuestToken(), owner = profileIdFromToken(token)!;
    const id = randomUUID(), snapshot = portableFixture();
    const c: Commitment = { id: "c1", title: "Встреча", parties: ["Мира"], place: "Кафе", due: { day: 2, minute: 600 }, status: "accepted", createdTurn: 1, updatedTurn: 2, note: "" };
    const world = { ...snapshot.session.worldState, clock: { day: 1, minute: 600 }, commitments: [c] };
    await fixture.pg.query("INSERT INTO game_sessions(id,owner_id,visibility,title,character,world_state,turn_count) VALUES ($1,$2,'public','Книга',$3,$4,3)", [id, owner, JSON.stringify(snapshot.session.character), JSON.stringify(world)]);
    const { PATCH } = await import("../src/app/api/sessions/[id]/commitments/route");
    const body = { id: "c1", version: await commitmentVersion(c), action: "fulfilled", note: "встреча состоялась" };
    const jobs: (() => Promise<void>)[] = [];
    const patch = (t: string, b: unknown = body) => cookieContext(`chronicle_guest=${t}`, () => PATCH(new Request(`http://localhost/api/sessions/${id}/commitments`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }), { params: Promise.resolve({ id }) }), jobs);
    const state = async () => (await fixture.pg.query<{world_state: WorldState}>("SELECT world_state FROM game_sessions WHERE id=$1", [id])).rows[0].world_state;
    assert.equal((await patch(stranger)).status, 404, "public readers cannot edit");
    await fixture.pg.query("INSERT INTO turn_requests(session_id,request_id,input_hash,action,is_free,base_turn,status,stage,lease_token,lease_expires_at) VALUES ($1,'busy','hash','wait',true,3,'running','context',$2,now()+interval '1 minute')", [id, randomUUID()]);
    assert.equal((await patch(token)).status, 429);
    assert.deepEqual(await state(), world);
    await fixture.pg.query("UPDATE turn_requests SET status='failed' WHERE session_id=$1", [id]);
    await fixture.pg.exec("CREATE FUNCTION reject_commitment_memory() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END $$; CREATE TRIGGER fail_memory BEFORE INSERT ON memory_nodes FOR EACH ROW EXECUTE FUNCTION reject_commitment_memory()");
    assert.equal((await patch(token)).status, 500);
    assert.deepEqual(await state(), world, "memory failure rolls world back");
    assert.equal(jobs.length, 0);
    await fixture.pg.exec("DROP TRIGGER fail_memory ON memory_nodes");
    const result = await patch(token);
    assert.equal(result.status, 200, await result.clone().text());
    assert.equal(result.headers.get("Cache-Control"), "private, no-store");
    assert.equal((await state()).commitments?.[0].status, "fulfilled");
    const memories = (await fixture.pg.query<{entity_key:string;content:string}>("SELECT entity_key,content FROM memory_nodes WHERE session_id=$1", [id])).rows;
    assert.equal(memories.length, 1);
    assert.equal(memories[0].entity_key, "commitment:c1");
    assert.match(memories[0].content, /Отметка владельца/);
    assert.equal(jobs.length, 1, "memory work scheduled only after committed success");
    assert.equal((await patch(token)).status, 409, "duplicate old edit is stale");
    assert.equal((await fixture.pg.query("SELECT id FROM memory_nodes WHERE session_id=$1", [id])).rows.length, 1);
  } finally { await fixture.close(); }
});
