import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { CampaignMode, RulesProfile } from "../src/db/schema";
import type { AgreementRevision } from "../src/lib/narrative-agreements";
import { HttpError } from "../src/lib/http";
import { accountsDb } from "./helpers/accounts-db";

type Database = Awaited<ReturnType<typeof accountsDb>>;
const durableTables = ["game_sessions", "game_turns", "inventory_items", "world_locations", "quests", "npcs", "scene_objects", "agreement_events", "memory_nodes", "memory_links", "memory_embeddings", "memory_jobs", "turn_requests", "campaign_checkpoints", "checkpoint_forks"] as const;

// SQL rows, including pre-existing ledger/outbox records, are the rollback oracle.
async function durableState(pg: Database["pg"]) {
  return Object.fromEntries(await Promise.all(durableTables.map(async table => [table,
    (await pg.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`)).rows,
  ])));
}

async function seed(pg: Database["pg"], campaignMode: CampaignMode = "free", rulesProfile: RulesProfile = "rules-light") {
  const sessionId = randomUUID(), itemId = randomUUID(), locationId = randomUUID(), narratorIds: string[] = [randomUUID(), randomUUID()];
  const memoryIds: string[] = [randomUUID(), randomUUID()], agreementId = randomUUID(), revisionIds: string[] = [randomUUID(), randomUUID()];
  const narration = [`Мира предлагает ключ. Запись ${narratorIds[0]}.`, "Лев принимает ключ в обмен на проезд до рассвета."];
  const character = { name: "Мира", archetype: "Путешественница", level: 1, xp: 0, hp: 10, maxHp: 10, gold: 5, stats: {}, skills: [], traits: [], backstory: "", appearance: "" };
  const world = { worldName: "Порт", tone: "Спокойный", era: "Сегодня", mainQuest: "Поездка", currentLocation: "Рынок", factions: [], flags: { key: itemId }, danger: 0, chapter: 1 };
  await pg.query("INSERT INTO game_sessions (id,title,owner_id,visibility,campaign_mode,rules_profile,character,world_state,turn_count) VALUES ($1,'Исходная история','checkpoint-owner','public',$2,$3,$4,$5,2)", [sessionId, campaignMode, rulesProfile, JSON.stringify(character), JSON.stringify(world)]);
  await pg.query("INSERT INTO inventory_items (id,session_id,name,kind,quantity) VALUES ($1,$2,'Ключ','tool',2)", [itemId, sessionId]);
  await pg.query("INSERT INTO world_locations (id,session_id,name,current,connected_to) VALUES ($1,$2,'Рынок',true,$3)", [locationId, sessionId, JSON.stringify([locationId])]);
  await pg.query("INSERT INTO quests (session_id,key,title,updated_turn) VALUES ($1,'travel','Поездка',2)", [sessionId]);
  await pg.query("INSERT INTO npcs (session_id,key,name,last_seen_turn,last_location) VALUES ($1,'lev','Лев',2,'Рынок')", [sessionId]);
  await pg.query("INSERT INTO scene_objects (session_id,key,name,location_name,state,updated_turn) VALUES ($1,'gate','Ворота','Рынок','открыты',2)", [sessionId]);
  for (let i = 0; i < 2; i++) {
    await pg.query("INSERT INTO memory_nodes (id,session_id,layer,category,title,content,parent_id,turn_from,turn_to,source,source_turn,entity_key) VALUES ($1,$2,'semantic','item',$3,$4,$5,1,2,'state',2,$6)", [memoryIds[i], sessionId, i ? "Проезд" : "Ключ", `Предмет item:${itemId} #${itemId.slice(0, 6)}`, i ? memoryIds[0] : null, `item:${itemId}`]);
    await pg.query("INSERT INTO game_turns (id,session_id,turn_number,role,content,context_meta) VALUES ($1,$2,$3,'narrator',$4,$5)", [narratorIds[i], sessionId, i + 1, narration[i], JSON.stringify({ model: "fixture", rulesProfile, digestChars: 0, retrievedIds: memoryIds })]);
    const source: AgreementRevision["source"] = { kind: "current_turn", originTurnId: narratorIds[i], turnNumber: i + 1, quote: narration[i], start: 0, end: narration[i].length, textSha256: createHash("sha256").update(narration[i]).digest("hex") };
    await pg.query("INSERT INTO agreement_events (id,agreement_id,session_id,turn_number,version,previous_revision_id,parties,object,consideration,conditions,status,rules_version,source) VALUES ($1,$2,$3,$4,$4,$5,$6,'ключ','проезд',$7,$8,1,$9)", [revisionIds[i], agreementId, sessionId, i + 1, i ? revisionIds[0] : null, JSON.stringify(["Мира", "Лев"]), JSON.stringify(["до рассвета"]), i ? "accepted" : "proposed", JSON.stringify(source)]);
    await pg.query("INSERT INTO memory_embeddings (memory_node_id,session_id,model,dims,content_hash,status) VALUES ($1,$2,'fixture',3,$3,'ready')", [memoryIds[i], sessionId, `source-${i}`]);
  }
  await pg.query("INSERT INTO game_turns (session_id,turn_number,role,content,request_id) VALUES ($1,2,'player','Предложить обмен','source-player-key')", [sessionId]);
  await pg.query("INSERT INTO memory_links (from_id,to_id,relation) VALUES ($1,$2,'explains')", memoryIds);
  await pg.query("INSERT INTO memory_jobs (session_id,turn_number,payload) VALUES ($1,2,$2)", [sessionId, JSON.stringify({ narration: narration[1], playerAction: "Предложить обмен", profileCanon: "", knownDigest: "" })]);
  await pg.query("INSERT INTO ai_settings (id,embedding_dims) VALUES ('checkpoint-owner',3)");
  return { sessionId, itemId, locationId, narratorIds, memoryIds, agreementId, revisionIds, narration, campaignMode, rulesProfile };
}

async function fixture(run: (f: Awaited<ReturnType<typeof seed>>, database: Database, services: typeof import("../src/lib/checkpoints")) => Promise<void>, campaignMode?: CampaignMode, rulesProfile?: RulesProfile) {
  const database = await accountsDb();
  try { await run(await seed(database.pg, campaignMode, rulesProfile), database, await import("../src/lib/checkpoints")); }
  finally { await database.close(); }
}

const conflict = (error: unknown) => error instanceof HttpError && error.status === 409 && error.code === "IDEMPOTENCY_CONFLICT";

test("P2 checkpoint limit admits twelve, rejects thirteen without SQL changes, and replays at the limit", async () => {
  await fixture(async (f, { pg }, services) => {
    const first = { sessionId: f.sessionId, title: "Точка 1", expectedTurn: 2, requestId: "checkpoint-1" };
    for (let i = 1; i <= 12; i++) assert.equal((await services.createCheckpoint({ ...first, title: `Точка ${i}`, requestId: `checkpoint-${i}` })).replay, false);
    assert.equal((await pg.query("SELECT id FROM campaign_checkpoints")).rows.length, 12);
    const before = await durableState(pg);
    await assert.rejects(services.createCheckpoint({ ...first, title: "Точка 13", requestId: "checkpoint-13" }), (error: unknown) => error instanceof HttpError && error.status === 409 && error.code === "CHECKPOINT_LIMIT");
    assert.deepEqual(await durableState(pg), before);
    assert.equal((await services.createCheckpoint(first)).replay, true);
    assert.deepEqual(await durableState(pg), before);
    const checkpointId = (await pg.query<{ id: string }>("SELECT id FROM campaign_checkpoints WHERE request_id='checkpoint-12'")).rows[0].id;
    await services.deleteCheckpoint(f.sessionId, checkpointId);
    assert.equal((await services.createCheckpoint({ ...first, title: "Точка 13", requestId: "checkpoint-13" })).replay, false);
    assert.equal((await pg.query("SELECT id FROM campaign_checkpoints")).rows.length, 12);
  });
});

for (const change of ["title", "expectedTurn"] as const) test(`P2 checkpoint same requestId with changed ${change} conflicts without modifying its saved snapshot`, async () => {
  await fixture(async (f, { pg }, services) => {
    const input = { sessionId: f.sessionId, title: "Исходная точка", expectedTurn: 2, requestId: "same-checkpoint-key" };
    await services.createCheckpoint(input);
    const before = await durableState(pg);
    await assert.rejects(services.createCheckpoint({ ...input, ...(change === "title" ? { title: "Другая точка" } : { expectedTurn: 3 }) }), conflict);
    assert.deepEqual(await durableState(pg), before);
    // Replay binds the saved turn, even when the source has advanced.
    await pg.query("UPDATE game_sessions SET turn_count=3 WHERE id=$1", [f.sessionId]);
    const advanced = await durableState(pg);
    const replay = await services.createCheckpoint(input);
    assert.equal(replay.replay, true);
    assert.equal(replay.checkpoint.turnNumber, 2);
    assert.deepEqual(await durableState(pg), advanced);
  });
});

test("P2 fork same requestId with a changed title conflicts; the unchanged request replays one persisted branch", async () => {
  await fixture(async (f, { pg }, services) => {
    const created = await services.createCheckpoint({ sessionId: f.sessionId, title: "До поездки", requestId: "fork-source" });
    const input = { sessionId: f.sessionId, checkpointId: created.checkpoint.id, title: "Ветка", requestId: "same-fork-key" };
    const fork = await services.forkCheckpoint(input);
    const before = await durableState(pg);
    await assert.rejects(services.forkCheckpoint({ ...input, title: "Другая ветка" }), conflict);
    assert.deepEqual(await durableState(pg), before);
    const replay = await services.forkCheckpoint(input);
    assert.equal(replay.replay, true);
    assert.equal(replay.session.id, fork.session.id);
    assert.deepEqual(await durableState(pg), before);
    assert.equal((await pg.query("SELECT id FROM checkpoint_forks")).rows.length, 1);
    assert.equal((await pg.query("SELECT id FROM game_sessions")).rows.length, 2);
  });
});

for (const [campaignMode, rulesProfile] of [["preset", "d20"], ["free", "rules-light"], ["free", "narrative"]] as const) test(`P2 deleting source checkpoint preserves the independent ${campaignMode}/${rulesProfile} branch, agreements and embedding outbox`, async () => {
  await fixture(async (f, { pg }, services) => {
    const created = await services.createCheckpoint({ sessionId: f.sessionId, title: "До поездки", requestId: "delete-source" });
    const input = { sessionId: f.sessionId, checkpointId: created.checkpoint.id, title: "Самостоятельная ветка", requestId: "delete-fork" };
    await services.forkCheckpoint(input);
    // Resolve the persisted branch through SQL; expected canon is literal fixture data.
    const branch = (await pg.query<{ id: string; owner_id: string; visibility: string; campaign_mode: string; rules_profile: string; world_state: { flags: { key: string } }; branch_origin: { checkpointId: string; checkpointTitle: string } }>("SELECT * FROM game_sessions WHERE title='Самостоятельная ветка'")).rows[0];
    assert.notEqual(branch.id, f.sessionId);
    assert.equal(branch.owner_id, "checkpoint-owner"); assert.equal(branch.visibility, "private");
    assert.equal(branch.campaign_mode, campaignMode); assert.equal(branch.rules_profile, rulesProfile);
    const items = (await pg.query<{ id: string; name: string; quantity: number }>("SELECT * FROM inventory_items WHERE session_id=$1", [branch.id])).rows;
    assert.equal(items.length, 1); assert.equal(items[0].name, "Ключ"); assert.equal(items[0].quantity, 2);
    assert.notEqual(items[0].id, f.itemId); assert.equal(branch.world_state.flags.key, items[0].id);
    const memories = (await pg.query<{ id: string; title: string; parent_id: string | null; entity_key: string; content: string }>("SELECT * FROM memory_nodes WHERE session_id=$1 ORDER BY title", [branch.id])).rows;
    assert.equal(memories.length, 2);
    assert.equal(memories[1].parent_id, memories[0].id);
    for (const memory of memories) {
      assert.ok(!f.memoryIds.includes(memory.id));
      assert.equal(memory.entity_key, `item:${items[0].id}`);
      assert.equal(memory.content, `Предмет item:${items[0].id} #${items[0].id.slice(0, 6)}`);
    }
    const links = (await pg.query<{ from_id: string; to_id: string; relation: string }>("SELECT l.* FROM memory_links l JOIN memory_nodes n ON n.id=l.from_id WHERE n.session_id=$1", [branch.id])).rows;
    assert.equal(links.length, 1); assert.equal(links[0].from_id, memories[0].id); assert.equal(links[0].to_id, memories[1].id); assert.equal(links[0].relation, "explains");
    const revisions = (await pg.query<{ id: string; agreement_id: string; previous_revision_id: string | null; status: string; object: string; consideration: string; source: AgreementRevision["source"] }>("SELECT * FROM agreement_events WHERE session_id=$1 ORDER BY version", [branch.id])).rows;
    assert.equal(revisions.length, 2); assert.deepEqual(revisions.map(r => r.status), ["proposed", "accepted"]);
    assert.deepEqual(revisions.map(r => r.object), ["ключ", "ключ"]); assert.deepEqual(revisions.map(r => r.consideration), ["проезд", "проезд"]);
    assert.notEqual(revisions[0].agreement_id, f.agreementId); assert.equal(revisions[0].previous_revision_id, null);
    assert.equal(revisions[1].agreement_id, revisions[0].agreement_id); assert.equal(revisions[1].previous_revision_id, revisions[0].id);
    for (let i = 0; i < 2; i++) {
      assert.ok(!f.revisionIds.includes(revisions[i].id)); assert.ok(!f.narratorIds.includes(revisions[i].source.originTurnId));
      assert.equal(revisions[i].source.quote, f.narration[i]);
      assert.equal(revisions[i].source.textSha256, createHash("sha256").update(f.narration[i]).digest("hex"));
      const origin = (await pg.query<{ content: string; session_id: string; context_meta: { retrievedIds: string[] } }>("SELECT * FROM game_turns WHERE id=$1", [revisions[i].source.originTurnId])).rows[0];
      assert.equal(origin.session_id, branch.id); assert.equal(origin.content, f.narration[i]);
      assert.deepEqual(new Set(origin.context_meta.retrievedIds), new Set(memories.map(m => m.id)));
    }
    assert.equal((await pg.query("SELECT id FROM game_turns WHERE session_id=$1 AND request_id IS NOT NULL", [branch.id])).rows.length, 0);
    const outbox = (await pg.query<{ memory_node_id: string; status: string; dims: number }>("SELECT * FROM memory_embeddings WHERE session_id=$1", [branch.id])).rows;
    assert.equal(outbox.length, 2); assert.ok(outbox.every(row => row.status === "pending" && row.dims === 3));
    assert.deepEqual(new Set(outbox.map(row => row.memory_node_id)), new Set(memories.map(m => m.id)));
    assert.equal((await pg.query("SELECT id FROM memory_jobs WHERE session_id=$1", [branch.id])).rows.length, 0);
    const before = await durableState(pg);
    await services.deleteCheckpoint(f.sessionId, created.checkpoint.id);
    const after = await durableState(pg);
    for (const table of durableTables.filter(table => table !== "campaign_checkpoints" && table !== "checkpoint_forks")) assert.deepEqual(after[table], before[table], `${table} survives source checkpoint deletion`);
    assert.deepEqual(after.campaign_checkpoints, []); assert.deepEqual(after.checkpoint_forks, []);
    assert.equal(branch.branch_origin.checkpointId, created.checkpoint.id); assert.equal(branch.branch_origin.checkpointTitle, "До поездки");
    await assert.rejects(services.forkCheckpoint(input), (error: unknown) => error instanceof HttpError && error.status === 404 && error.code === "NOT_FOUND");
    await assert.rejects(services.deleteCheckpoint(f.sessionId, created.checkpoint.id), (error: unknown) => error instanceof HttpError && error.status === 404);
    assert.deepEqual(await durableState(pg), after);
    // A surviving branch can independently create a valid checkpoint after its source is gone.
    assert.equal((await services.createCheckpoint({ sessionId: branch.id, title: "Точка ветки", expectedTurn: 2, requestId: "branch-checkpoint" })).replay, false);
  }, campaignMode, rulesProfile);
});

for (const faultTable of ["scene_objects", "checkpoint_forks"] as const) test(`P2 real SQL failure at ${faultTable} rolls back the fork, ledger and embedding outbox while preserving an existing branch`, async () => {
  await fixture(async (f, { pg }, services) => {
    const created = await services.createCheckpoint({ sessionId: f.sessionId, title: "До поездки", requestId: "rollback-source" });
    await services.forkCheckpoint({ sessionId: f.sessionId, checkpointId: created.checkpoint.id, title: "Существующая ветка", requestId: "existing-fork" });
    const before = await durableState(pg);
    // Database constraint failure: production fork SQL runs unchanged up to this phase.
    await pg.exec(`CREATE FUNCTION p2_reject_fork() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'P2_SQL_FORK_FAILURE' USING ERRCODE = '23514'; END $$;
      CREATE TRIGGER p2_reject_fork BEFORE INSERT ON ${faultTable} FOR EACH ROW EXECUTE FUNCTION p2_reject_fork();`);
    const input = { sessionId: f.sessionId, checkpointId: created.checkpoint.id, title: "Повторяемая ветка", requestId: "failed-fork" };
    let rejected: unknown;
    try { await services.forkCheckpoint(input); } catch (error) { rejected = error; }
    assert.ok(rejected, "the actual SQL failure must escape forkCheckpoint");
    const cause = (rejected as { cause?: { code?: string; message?: string } }).cause;
    assert.equal(cause?.code, "23514"); assert.match(cause?.message ?? "", /P2_SQL_FORK_FAILURE/);
    assert.deepEqual(await durableState(pg), before, "no partially copied table, idempotency ledger or outbox row may remain");
    await pg.exec(`DROP TRIGGER p2_reject_fork ON ${faultTable}; DROP FUNCTION p2_reject_fork();`);
    const recovered = await services.forkCheckpoint(input);
    assert.equal(recovered.replay, false);
    const committed = await durableState(pg);
    const replay = await services.forkCheckpoint(input);
    assert.equal(replay.replay, true); assert.equal(replay.session.id, recovered.session.id);
    assert.deepEqual(await durableState(pg), committed);
    assert.equal((await pg.query("SELECT id FROM game_sessions")).rows.length, 3);
    assert.equal((await pg.query("SELECT id FROM checkpoint_forks")).rows.length, 2);
    assert.equal((await pg.query("SELECT id FROM memory_embeddings WHERE session_id=$1", [recovered.session.id])).rows.length, 2);
    await services.deleteCheckpoint(f.sessionId, created.checkpoint.id);
    assert.equal((await pg.query("SELECT id FROM game_sessions")).rows.length, 3);
    assert.equal((await pg.query("SELECT id FROM memory_embeddings")).rows.length, 6);
  });
});
