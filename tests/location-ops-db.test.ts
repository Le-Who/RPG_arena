import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountsDb } from "./helpers/accounts-db";
import { executeLocationOp, type LocationDbOp } from "../src/lib/location-ops";
import { emptyChanges } from "../src/lib/resolution";
import type { AIConfig } from "../src/lib/ai-settings";

const campaign = "10000000-0000-4000-8000-000000000001";
const foreignCampaign = "10000000-0000-4000-8000-000000000002";
const square = "20000000-0000-4000-8000-000000000001";
const dock = "20000000-0000-4000-8000-000000000002";
const foreignSquare = "30000000-0000-4000-8000-000000000001";
const foreignDock = "30000000-0000-4000-8000-000000000002";
const character = { name: "Ада", archetype: "Путник", level: 1, xp: 0, hp: 20, maxHp: 20, gold: 0, stats: {}, skills: [], traits: [], conditions: [], backstory: "", appearance: "" };
const world = { worldName: "Город", tone: "Спокойный", era: "Сегодня", mainQuest: "", currentLocation: "Площадь", factions: [], flags: {}, danger: 0, chapter: 1 };
const cfg: AIConfig = {
  keys: [], dbKeyCount: 0, envKeyCount: 0, useLiveAI: true, canUseLive: true,
  textProvider: "openrouter", textModel: "fixture/story", textApiKey: "synthetic-map-key",
  routingConfig: { profile: "balanced", narrationModel: "gemini-3.5-flash-lite", customActionModel: "gemini-3.8-flash", compactionModel: "gemini-3.8-flash", fastTaskModel: "gemini-3.5-flash-lite" },
  limits: { flash: 20, lite: 500 }, enforceLimits: false, embeddingsEnabled: false,
  embeddingModel: "gemini-embedding-2", embeddingDims: 768, semanticExtractionEnabled: false,
};

async function fixture() {
  const database = await accountsDb();
  try {
    // Insert the foreign campaign first: an accidentally unscoped name lookup must not pass by row order.
    for (const id of [foreignCampaign, campaign]) await database.pg.query(
      "INSERT INTO game_sessions(id,title,campaign_mode,rules_profile,character,world_state,turn_count,owner_id) VALUES ($1,'Map fixture','free','narrative',$2,$3,1,$4)",
      [id, JSON.stringify(character), JSON.stringify(world), `map-owner-${id}`],
    );
    for (const [id, session, name, x, current] of [
      [foreignSquare, foreignCampaign, "Площадь", 30, true],
      [foreignDock, foreignCampaign, "Док", 40, false],
      [square, campaign, "Площадь", 5, true],
      [dock, campaign, "Док", 8, false],
    ] as const) await database.pg.query(
      "INSERT INTO world_locations(id,session_id,name,description,x,y,current,discovered,danger,icon,connected_to) VALUES ($1,$2,$3,$4,$5,5,$6,$6,0,'📍','[]')",
      [id, session, name, `Описание ${id}`, x, current],
    );
    return database;
  } catch (error) { await database.close(); throw error; }
}

async function rows(database: Awaited<ReturnType<typeof accountsDb>>, sessionId: string) {
  return (await database.pg.query<{
    id: string; session_id: string; name: string; description: string; x: number; y: number;
    current: boolean; discovered: boolean; danger: number; icon: string; connected_to: string[];
  }>("SELECT * FROM world_locations WHERE session_id=$1 ORDER BY id", [sessionId])).rows;
}

async function execute(ops: LocationDbOp[]) {
  const { db } = await import("../src/db");
  await db.transaction(async tx => { for (const op of ops) await executeLocationOp(tx, campaign, op); });
}

for (const [target, id] of [
  ["foreign", foreignDock],
  ["nonexistent", "40000000-0000-4000-8000-000000000001"],
] as const) {
  // Catches clearing current before establishing that the target belongs to this campaign.
  test(`real location current selection leaves every row unchanged for a ${target} target`, async () => {
    const database = await fixture();
    try {
      const localBefore = await rows(database, campaign), foreignBefore = await rows(database, foreignCampaign);
      await execute([{ t: "loc.setCurrent", id }]);
      assert.deepEqual(await rows(database, campaign), localBefore);
      assert.deepEqual(await rows(database, foreignCampaign), foreignBefore);
    } finally { await database.close(); }
  });
}

// Catches wrong current flags, blanket discovery, loss of earlier discovery, or unrelated field writes.
test("real location current selection switches exactly to a local target and preserves rows on repetition", async () => {
  const database = await fixture();
  const hidden = "20000000-0000-4000-8000-000000000003";
  try {
    await database.pg.query(
      "INSERT INTO world_locations(id,session_id,name,description,x,y,current,discovered,danger,icon,connected_to) VALUES ($1,$2,'Башня','Скрытая башня',12,7,false,false,35,'🏰',$3)",
      [hidden, campaign, JSON.stringify([square])],
    );
    await database.pg.query("UPDATE world_locations SET danger=17,icon='⚓',connected_to=$1 WHERE id=$2", [JSON.stringify([square]), dock]);
    const localBefore = await rows(database, campaign), foreignBefore = await rows(database, foreignCampaign);
    await execute([{ t: "loc.setCurrent", id: dock }]);
    const expected = [
      { ...localBefore[0], current: false },
      { ...localBefore[1], current: true, discovered: true },
      localBefore[2],
    ];
    assert.deepEqual(await rows(database, campaign), expected);
    assert.deepEqual(await rows(database, foreignCampaign), foreignBefore);
    await execute([{ t: "loc.setCurrent", id: dock }]);
    assert.deepEqual(await rows(database, campaign), expected);
    assert.deepEqual(await rows(database, foreignCampaign), foreignBefore);
  } finally { await database.close(); }
});

// Catches missing campaign predicates on current/discovery writes and incorrect symmetric endpoints.
test("real location SQL changes only the chosen campaign despite colliding location slugs", async () => {
  const database = await fixture();
  try {
    const foreignBefore = await rows(database, foreignCampaign);
    await execute([{ t: "loc.discover", id: dock }, { t: "loc.setCurrent", id: dock },
      { t: "loc.connect", fromId: square, toId: dock }, { t: "loc.connect", fromId: square, toId: dock }]);
    assert.deepEqual((await rows(database, campaign)).map(row => ({ id: row.id, current: row.current, discovered: row.discovered, connectedTo: row.connected_to })), [
      { id: square, current: false, discovered: true, connectedTo: [dock] },
      { id: dock, current: true, discovered: true, connectedTo: [square] },
    ]);
    assert.deepEqual(await rows(database, foreignCampaign), foreignBefore);
  } finally { await database.close(); }
});

// Catches removal of the connect/discover session scope, including a mixed local/foreign route.
test("real location SQL refuses foreign discovery and routes with foreign or missing endpoints", async () => {
  const database = await fixture();
  try {
    const localBefore = await rows(database, campaign), foreignBefore = await rows(database, foreignCampaign);
    await execute([{ t: "loc.discover", id: foreignDock },
      { t: "loc.connect", fromId: square, toId: foreignDock },
      { t: "loc.connect", fromId: foreignSquare, toId: foreignDock },
      { t: "loc.connect", fromId: square, toId: randomUUID() },
      { t: "loc.connect", fromId: square, toId: square }]);
    assert.deepEqual(await rows(database, campaign), localBefore);
    assert.deepEqual(await rows(database, foreignCampaign), foreignBefore);
  } finally { await database.close(); }
});

test("real location insert with a colliding name resets current only in its campaign", async () => {
  const database = await fixture();
  const inserted = "20000000-0000-4000-8000-000000000003";
  try {
    const foreignBefore = await rows(database, foreignCampaign);
    await execute([{ t: "loc.insert", row: { id: inserted, name: "Док", description: "Другой док", x: 9, y: 6, danger: 0, current: true, discovered: true, icon: "📍" } }]);
    assert.deepEqual((await rows(database, campaign)).map(row => ({ id: row.id, current: row.current, connectedTo: row.connected_to })), [
      { id: square, current: false, connectedTo: [] }, { id: dock, current: false, connectedTo: [] },
      { id: inserted, current: true, connectedTo: [] },
    ]);
    const insertedRow = (await rows(database, campaign))[2];
    assert.equal(insertedRow.session_id, campaign);
    assert.equal(insertedRow.name, "Док");
    assert.equal(insertedRow.description, "Другой док");
    assert.deepEqual(await rows(database, foreignCampaign), foreignBefore);
  } finally { await database.close(); }
});

async function proposedTurn(stateChanges: ReturnType<typeof emptyChanges>) {
  const { performTurn } = await import("../src/lib/turn");
  const transport = mock.method(globalThis, "fetch", async (url: unknown) => {
    assert.equal(String(url), "https://openrouter.ai/api/v1/chat/completions");
    return Response.json({ choices: [{ message: { content: JSON.stringify({
      outcome: "neutral", effects: { hp: 0, xp: 0, gold: 0, danger: 0 }, stateChanges,
      continuity: { mode: "event", referencesPast: false }, choices: [], narration: "Ада рассматривает карту города.",
    }) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
  });
  try {
    return await performTurn({ sessionId: campaign, requestId: randomUUID(), expectedTurn: 1, isFree: true, action: "Рассматриваю карту города" }, {
      loadAIConfig: async () => cfg, loadNarrativeConfig: async () => ({ enabled: false, provider: "openrouter", apiKey: "" }),
      schedule() {}, scheduleDiagnostics() {},
    });
  } finally { transport.mock.restore(); }
}

// Catches an unscoped consumer lookup even when individual SQL writes retain their own session predicates.
test("performTurn exposes and persists movement to the local endpoints under campaign slug collisions", async () => {
  const database = await fixture();
  try {
    const foreignBefore = await rows(database, foreignCampaign);
    const changes = emptyChanges();
    changes.location = { action: "move", ref: null, name: "Док", description: "У воды", danger: 0 };
    const result = await proposedTurn(changes);
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.applied.location, { from: "Площадь", to: "Док", isNew: false });
    assert.equal(result.state?.worldState.currentLocation, "Док");
    assert.deepEqual((await rows(database, campaign)).map(row => ({ id: row.id, current: row.current, discovered: row.discovered, connectedTo: row.connected_to })), [
      { id: square, current: false, discovered: true, connectedTo: [dock] },
      { id: dock, current: true, discovered: true, connectedTo: [square] },
    ]);
    const narrator = (await database.pg.query<{ state_changes: { location: unknown } }>("SELECT state_changes FROM game_turns WHERE session_id=$1 AND role='narrator'", [campaign])).rows;
    assert.equal(narrator.length, 1);
    assert.deepEqual(narrator[0].state_changes.location, { from: "Площадь", to: "Док", isNew: false });
    const events = (await database.pg.query<{ session_id: string; entity_key: string; content: string }>("SELECT session_id,entity_key,content FROM memory_nodes WHERE category='location' ORDER BY entity_key")).rows;
    assert.equal(events.length, 1);
    assert.equal(events[0].session_id, campaign);
    assert.equal(events[0].entity_key, "location:док");
    assert.match(events[0].content, /Герой прибыл сюда из «Площадь»/);
    assert.deepEqual(await rows(database, foreignCampaign), foreignBefore);
  } finally { await database.close(); }
});

for (const conflict of ["ambiguous local name", "explicit foreign reference"] as const) {
  // Catches phantom applied movement or memory events when a proposed target cannot be resolved locally.
  test(`performTurn rejects ${conflict} without phantom location changes, events or links`, async () => {
    const database = await fixture();
    try {
      if (conflict === "ambiguous local name") await database.pg.query(
        "INSERT INTO world_locations(session_id,name,x,y,current,discovered) VALUES ($1,'Док',9,6,false,false)", [campaign],
      );
      const localBefore = await rows(database, campaign), foreignBefore = await rows(database, foreignCampaign);
      const ref = conflict === "explicit foreign reference" ? foreignDock : null;
      const changes = emptyChanges();
      changes.location = { action: "move", ref, name: "Док", description: "У воды", danger: 0 };
      changes.locations = [{ ref, name: "Док", description: "У воды", danger: 0 }];
      changes.routes = [{ from: square, to: ref ?? "Док" }];
      const result = await proposedTurn(changes);
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(result.applied.location, null);
      assert.equal(result.state?.worldState.currentLocation, "Площадь");
      assert.equal(result.applied.rejected.filter(reason => reason.startsWith("Локация отклонена:")).length, 2);
      assert.equal(result.applied.rejected.filter(reason => reason.startsWith("Маршрут отклонён:")).length, 1);
      assert.deepEqual(await rows(database, campaign), localBefore);
      assert.deepEqual(await rows(database, foreignCampaign), foreignBefore);
      const narrator = (await database.pg.query<{ state_changes: { location: unknown } }>("SELECT state_changes FROM game_turns WHERE session_id=$1 AND role='narrator'", [campaign])).rows;
      assert.equal(narrator.length, 1);
      assert.equal(narrator[0].state_changes.location, null);
      assert.deepEqual((await database.pg.query("SELECT id FROM memory_nodes WHERE category='location'")).rows, []);
    } finally { await database.close(); }
  });
}
