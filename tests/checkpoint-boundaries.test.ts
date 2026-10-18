import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HttpError } from "../src/lib/http";
import { snapshotChecksum } from "../src/lib/checkpoint-snapshot";
import type { CheckpointSnapshot } from "../src/lib/checkpoint-types";
import { accountsDb } from "./helpers/accounts-db";

type Database = Awaited<ReturnType<typeof accountsDb>>;
const durableTables = ["game_sessions", "game_turns", "inventory_items", "world_locations", "quests", "npcs", "scene_objects", "agreement_events", "memory_nodes", "memory_links", "memory_embeddings", "memory_jobs", "turn_requests", "campaign_checkpoints", "checkpoint_forks"] as const;
const tooLarge = (error: unknown) => error instanceof HttpError && error.status === 413 && error.code === "CHECKPOINT_TOO_LARGE";
const integrity = (error: unknown) => error instanceof HttpError && error.status === 409 && error.code === "SNAPSHOT_INTEGRITY";

async function durableState(pg: Database["pg"]) {
  return Object.fromEntries(await Promise.all(durableTables.map(async table => [table,
    (await pg.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`)).rows,
  ])));
}

async function fixture(run: (f: { sessionId: string; checkpointId: string; snapshot: CheckpointSnapshot }, database: Database, services: typeof import("../src/lib/checkpoints")) => Promise<void>) {
  const database = await accountsDb();
  try {
    const { pg } = database, sessionId = randomUUID();
    const character = { name: "Мира", archetype: "Путешественница", level: 1, xp: 0, hp: 0, maxHp: 0, gold: 0, stats: {}, skills: [], traits: [], backstory: "", appearance: "" };
    const world = { worldName: "Порт", tone: "Спокойный", era: "Сегодня", mainQuest: "Поездка", currentLocation: "Рынок", factions: [], flags: {}, danger: 0, chapter: 1 };
    await pg.query("INSERT INTO game_sessions (id,title,owner_id,campaign_mode,rules_profile,character,world_state,turn_count) VALUES ($1,'Граница снимка','boundary-owner','free','narrative',$2,$3,1)", [sessionId, JSON.stringify(character), JSON.stringify(world)]);
    await pg.query("INSERT INTO game_turns (session_id,turn_number,role,content) VALUES ($1,1,'narrator','')", [sessionId]);
    await pg.query("INSERT INTO world_locations (session_id,name,current) VALUES ($1,'Рынок',true)", [sessionId]);
    await pg.query("INSERT INTO inventory_items (session_id,name) VALUES ($1,'Ключ')", [sessionId]);
    await pg.query("INSERT INTO quests (session_id,key,title,updated_turn) VALUES ($1,'travel','Поездка',1)", [sessionId]);
    await pg.query("INSERT INTO npcs (session_id,key,name,last_seen_turn) VALUES ($1,'lev','Лев',1)", [sessionId]);
    await pg.query("INSERT INTO scene_objects (session_id,key,name,location_name,state,updated_turn) VALUES ($1,'gate','Ворота','Рынок','открыты',1)", [sessionId]);
    await pg.query("INSERT INTO memory_nodes (session_id,layer,category,title,content) SELECT $1,'semantic','world',v,'Факт' FROM unnest(ARRAY['Рынок','Порт']) AS v", [sessionId]);
    const memories = (await pg.query<{ id: string }>("SELECT id FROM memory_nodes ORDER BY id")).rows;
    await pg.query("INSERT INTO memory_links (from_id,to_id,relation) VALUES ($1,$2,'explains')", [memories[0].id, memories[1].id]);
    const services = await import("../src/lib/checkpoints");
    const created = await services.createCheckpoint({ sessionId, title: "Исходная точка", requestId: "initial" });
    const snapshot = (await pg.query<{ snapshot: CheckpointSnapshot }>("SELECT snapshot FROM campaign_checkpoints WHERE id=$1", [created.checkpoint.id])).rows[0].snapshot;
    await run({ sessionId, checkpointId: created.checkpoint.id, snapshot }, database, services);
  } finally { await database.close(); }
}

async function storeSnapshot(pg: Database["pg"], checkpointId: string, value: unknown) {
  const snapshot = value as CheckpointSnapshot;
  await pg.query("UPDATE campaign_checkpoints SET snapshot=$2,checksum=$3 WHERE id=$1", [checkpointId, JSON.stringify(snapshot), snapshotChecksum(snapshot)]);
}

async function rejectInsertSentinel(pg: Database["pg"]) {
  // A rollback alone cannot distinguish pre-insert validation from an error
  // halfway through copying. This SQL sentinel proves validation wins first.
  await pg.exec(`CREATE FUNCTION boundary_reject_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'UNEXPECTED_SNAPSHOT_INSERT' USING ERRCODE = '23514'; END $$;
    CREATE TRIGGER boundary_reject_insert BEFORE INSERT ON game_sessions FOR EACH ROW EXECUTE FUNCTION boundary_reject_insert();`);
}

// The payload mixes Cyrillic, a surrogate pair and spaces: UTF-8 byte size is
// deliberately different from JS string length, without huge full-text tokens.
function contentAtBytes(snapshot: CheckpointSnapshot, bytes: number) {
  const empty = structuredClone(snapshot); empty.turns[0].content = "";
  const available = bytes - Buffer.byteLength(JSON.stringify(empty), "utf8");
  return "я 🌌 ".repeat(Math.floor(available / 8)) + "x".repeat(available % 8);
}

test("checkpoint create and fork retain every byte at the inclusive 4 MiB UTF-8 limit and reject one byte more atomically", async () => {
  await fixture(async (f, { pg }, services) => {
    const cap = 4 * 1024 * 1024, content = contentAtBytes(f.snapshot, cap);
    assert.ok(content.length < cap, "the control must distinguish UTF-8 bytes from code units");
    await pg.query("UPDATE game_turns SET content=$2 WHERE session_id=$1", [f.sessionId, content]);
    const created = await services.createCheckpoint({ sessionId: f.sessionId, title: "Ровно 4 МиБ", requestId: "bytes-at-cap" });
    const saved = (await pg.query<{ snapshot: CheckpointSnapshot }>("SELECT snapshot FROM campaign_checkpoints WHERE id=$1", [created.checkpoint.id])).rows[0].snapshot;
    assert.equal(Buffer.byteLength(JSON.stringify(saved), "utf8"), cap);
    assert.equal(saved.turns[0].content, content);
    const fork = await services.forkCheckpoint({ sessionId: f.sessionId, checkpointId: created.checkpoint.id, title: "Полная ветка", requestId: "bytes-at-cap-fork" });
    assert.equal((await pg.query<{ content: string }>("SELECT content FROM game_turns WHERE session_id=$1", [fork.session.id])).rows[0].content, content);
    await pg.query("UPDATE game_turns SET content=$2 WHERE session_id=$1", [f.sessionId, content + "x"]);
    const beforeCreate = await durableState(pg);
    await assert.rejects(services.createCheckpoint({ sessionId: f.sessionId, title: "На байт больше", requestId: "bytes-over-cap" }), tooLarge);
    assert.deepEqual(await durableState(pg), beforeCreate);
    saved.turns[0].content += "x";
    assert.equal(Buffer.byteLength(JSON.stringify(saved), "utf8"), cap + 1);
    await storeSnapshot(pg, created.checkpoint.id, saved);
    await rejectInsertSentinel(pg);
    const beforeFork = await durableState(pg);
    await assert.rejects(services.forkCheckpoint({ sessionId: f.sessionId, checkpointId: created.checkpoint.id, title: "Лишний байт", requestId: "bytes-over-cap-fork" }), tooLarge);
    assert.deepEqual(await durableState(pg), beforeFork);
  });
});

const rowCases = [
  { key: "turns", table: "game_turns", cap: 2000, insert: "(session_id,turn_number,role,content) SELECT $1,1,'player','Реплика' FROM generate_series(1,$2::int)" },
  { key: "inventory", table: "inventory_items", cap: 1000, insert: "(session_id,name) SELECT $1,'Предмет ' || n FROM generate_series(1,$2::int) n" },
  { key: "locations", table: "world_locations", cap: 1000, insert: "(session_id,name) SELECT $1,'Место ' || n FROM generate_series(1,$2::int) n" },
  { key: "quests", table: "quests", cap: 1000, insert: "(session_id,key,title,updated_turn) SELECT $1,'quest-' || n,'Задача',1 FROM generate_series(1,$2::int) n" },
  { key: "npcs", table: "npcs", cap: 1000, insert: "(session_id,key,name,last_seen_turn) SELECT $1,'npc-' || n,'Сосед',1 FROM generate_series(1,$2::int) n" },
  { key: "sceneObjects", table: "scene_objects", cap: 1000, insert: "(session_id,key,name,location_name,state,updated_turn) SELECT $1,'object-' || n,'Объект','Рынок','цел',1 FROM generate_series(1,$2::int) n" },
  { key: "memories", table: "memory_nodes", cap: 1000, insert: "(session_id,layer,category,title,content) SELECT $1,'semantic','world','Факт ' || n,'Содержание' FROM generate_series(1,$2::int) n" },
] as const;

for (const row of rowCases) test(`checkpoint create includes all ${row.cap} ${row.key} rows and rejects cap+1 without truncating or changing SQL`, async () => {
  await fixture(async (f, { pg }, services) => {
    await pg.query(`INSERT INTO ${row.table} ${row.insert}`, [f.sessionId, row.cap - f.snapshot[row.key].length]);
    const created = await services.createCheckpoint({ sessionId: f.sessionId, title: "На границе строк", requestId: "rows-at-cap" });
    const snapshot = (await pg.query<{ snapshot: CheckpointSnapshot }>("SELECT snapshot FROM campaign_checkpoints WHERE id=$1", [created.checkpoint.id])).rows[0].snapshot;
    const sourceIds = (await pg.query<{ id: string }>(`SELECT id FROM ${row.table} WHERE session_id=$1`, [f.sessionId])).rows.map(r => r.id);
    assert.equal(snapshot[row.key].length, row.cap);
    assert.deepEqual(new Set(snapshot[row.key].map(r => r.id)), new Set(sourceIds));
    const fork = await services.forkCheckpoint({ sessionId: f.sessionId, checkpointId: created.checkpoint.id, title: "Ветка на границе строк", requestId: "rows-at-cap-fork" });
    assert.equal((await pg.query(`SELECT id FROM ${row.table} WHERE session_id=$1`, [fork.session.id])).rows.length, row.cap);
    // Use a distinct natural key for the cap+1 source row.
    const overflow = row.key === "quests" || row.key === "npcs" || row.key === "sceneObjects"
      ? row.insert.replace(/'quest-' \|\| n|'npc-' \|\| n|'object-' \|\| n/, "'overflow-' || n")
      : row.insert;
    await pg.query(`INSERT INTO ${row.table} ${overflow}`, [f.sessionId, 1]);
    const before = await durableState(pg);
    await assert.rejects(services.createCheckpoint({ sessionId: f.sessionId, title: "Сверх границы строк", requestId: "rows-over-cap" }), tooLarge);
    assert.deepEqual(await durableState(pg), before);
    assert.equal((await pg.query(`SELECT id FROM ${row.table} WHERE session_id=$1`, [f.sessionId])).rows.length, row.cap + 1);
  });
});

for (const row of rowCases) test(`checkpoint fork rejects a matching-checksum persisted snapshot above the ${row.key} row cap before inserts`, async () => {
  await fixture(async (f, { pg }, services) => {
    const rows = f.snapshot[row.key];
    while (rows.length <= row.cap) rows.push({ ...rows[0], id: randomUUID(), ...(row.key === "locations" ? { current: false } : {}) } as never);
    await storeSnapshot(pg, f.checkpointId, f.snapshot);
    await rejectInsertSentinel(pg);
    const before = await durableState(pg);
    await assert.rejects(services.forkCheckpoint({ sessionId: f.sessionId, checkpointId: f.checkpointId, title: "Слишком много строк", requestId: "persisted-rows-over-cap" }), tooLarge);
    assert.deepEqual(await durableState(pg), before);
  });
});

const malformed: { label: string; corrupt: (snapshot: CheckpointSnapshot) => unknown }[] = [
  { label: "null root", corrupt: () => null },
  { label: "null session", corrupt: s => ({ ...s, session: null }) },
  { label: "null world state", corrupt: s => ({ ...s, session: { ...s.session, worldState: null } }) },
  { label: "null character", corrupt: s => ({ ...s, session: { ...s.session, character: null } }) },
  ...["turns", "inventory", "locations", "quests", "npcs", "sceneObjects", "memories", "links"].map(key => ({ label: `${key} is not an array`, corrupt: (s: CheckpointSnapshot) => ({ ...s, [key]: {} }) })),
  { label: "null entity row", corrupt: s => ({ ...s, inventory: [null] }) },
  { label: "non-string entity identity", corrupt: s => ({ ...s, inventory: [{ ...s.inventory[0], id: 42 }] }) },
  { label: "null link row", corrupt: s => ({ ...s, links: [null] }) },
  { label: "null agreement row", corrupt: s => ({ ...s, agreements: [null] }) },
  { label: "malformed retrieval references", corrupt: s => ({ ...s, turns: [{ ...s.turns[0], contextMeta: { model: "fixture", rulesProfile: "narrative", digestChars: 0, retrievedIds: {} } }] }) },
  { label: "malformed location references", corrupt: s => ({ ...s, locations: [{ ...s.locations[0], connectedTo: {} }] }) },
  { label: "missing verification evidence", corrupt: s => ({ ...s, turns: [{ ...s.turns[0], contextMeta: { model: "fixture", rulesProfile: "narrative", digestChars: 0, retrievedIds: [], narrativeVerification: { version: 1 } } }] }) },
  { label: "malformed evidence sources", corrupt: s => ({ ...s, turns: [{ ...s.turns[0], contextMeta: { model: "fixture", rulesProfile: "narrative", digestChars: 0, retrievedIds: [], narrativeVerification: { version: 1, evidence: { sources: {} } } } }] }) },
  { label: "null evidence source", corrupt: s => ({ ...s, turns: [{ ...s.turns[0], contextMeta: { model: "fixture", rulesProfile: "narrative", digestChars: 0, retrievedIds: [], narrativeVerification: { version: 1, evidence: { sources: [null] } } } }] }) },
  { label: "malformed commitments", corrupt: s => ({ ...s, session: { ...s.session, worldState: { ...s.session.worldState, commitments: {} } } }) },
  { label: "null commitment", corrupt: s => ({ ...s, session: { ...s.session, worldState: { ...s.session.worldState, commitments: [null] } } }) },
  { label: "malformed commitment history", corrupt: s => ({ ...s, session: { ...s.session, worldState: { ...s.session.worldState, commitments: [{ history: {} }] } } }) },
  { label: "null commitment history entry", corrupt: s => ({ ...s, session: { ...s.session, worldState: { ...s.session.worldState, commitments: [{ history: [null] }] } } }) },
];

for (const item of malformed) test(`checkpoint fork classifies ${item.label} with a matching checksum as integrity failure before inserts`, async () => {
  await fixture(async (f, { pg }, services) => {
    await storeSnapshot(pg, f.checkpointId, item.corrupt(f.snapshot));
    await rejectInsertSentinel(pg);
    const before = await durableState(pg);
    await assert.rejects(services.forkCheckpoint({ sessionId: f.sessionId, checkpointId: f.checkpointId, title: "Повреждённая точка", requestId: "malformed-fork" }), integrity);
    assert.deepEqual(await durableState(pg), before);
  });
});

for (const collision of ["another link", "memory entity", "session"] as const) test(`checkpoint fork rejects link identity colliding with ${collision} before inserts`, async () => {
  await fixture(async (f, { pg }, services) => {
    if (collision === "another link") f.snapshot.links.push({ ...f.snapshot.links[0] });
    else f.snapshot.links[0].id = collision === "memory entity" ? f.snapshot.memories[0].id : f.sessionId;
    await storeSnapshot(pg, f.checkpointId, f.snapshot);
    await rejectInsertSentinel(pg);
    const before = await durableState(pg);
    await assert.rejects(services.forkCheckpoint({ sessionId: f.sessionId, checkpointId: f.checkpointId, title: "Повторный идентификатор", requestId: "duplicate-link-fork" }), integrity);
    assert.deepEqual(await durableState(pg), before);
  });
});

test("checkpoint fork accepts a legacy v1 snapshot without the optional agreements journal and retains nullable location references", async () => {
  await fixture(async (f, { pg }, services) => {
    delete f.snapshot.agreements;
    f.snapshot.locations[0].connectedTo = null;
    await storeSnapshot(pg, f.checkpointId, f.snapshot);
    const fork = await services.forkCheckpoint({ sessionId: f.sessionId, checkpointId: f.checkpointId, title: "Старая точка", requestId: "legacy-fork" });
    assert.equal(fork.replay, false);
    const branch = (await pg.query<{ campaign_mode: string; rules_profile: string }>("SELECT campaign_mode,rules_profile FROM game_sessions WHERE id=$1", [fork.session.id])).rows[0];
    assert.deepEqual(branch, { campaign_mode: "free", rules_profile: "narrative" });
    assert.equal((await pg.query("SELECT id FROM agreement_events WHERE session_id=$1", [fork.session.id])).rows.length, 0);
    assert.deepEqual((await pg.query<{ connected_to: unknown }>("SELECT connected_to FROM world_locations WHERE session_id=$1", [fork.session.id])).rows[0].connected_to, []);
    assert.equal((await pg.query("SELECT id FROM memory_embeddings WHERE session_id=$1 AND status='pending'", [fork.session.id])).rows.length, 2);
  });
});
