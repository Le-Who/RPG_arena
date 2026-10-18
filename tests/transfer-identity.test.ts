import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { CharacterState, WorldState } from "../src/db/schema";
import type { AIConfig } from "../src/lib/ai-settings";
import { emptyChanges } from "../src/lib/resolution";
import { applyLife, emptyLifeChanges, readLife, type ApplyLifeInput, type Holding } from "../src/lib/world-life";
import { accountsDb } from "./helpers/accounts-db";

const item = { id: "11111111-aaaa-4aaa-8aaa-111111111111", name: "Книга стихов", kind: "misc", quantity: 3, equipped: false, description: "Томик с подписью", icon: "📘", power: 0 };
const anna = { id: "npc-1", key: "anna", name: "Анна", role: "подруга", relation: 0, status: "alive" as const, description: "", lastLocation: "Кафе" };
const boris = { ...anna, id: "npc-2", key: "boris", name: "Борис" };
const cafe = { id: "cafe", name: "Кафе", x: 0, y: 0, current: true, discovered: true, danger: 0 };
const park = { ...cafe, id: "park", name: "Парк", current: false };
const world = (): WorldState => ({ worldName: "Город", tone: "повседневность", era: "наши дни", mainQuest: "", currentLocation: "Кафе", factions: [], flags: {}, danger: 0, chapter: 1, clock: { day: 1, minute: 540 } });
const input = (to: string, patch: Partial<ApplyLifeInput> = {}): ApplyLifeInput => ({
  world: world(), inventory: [structuredClone(item)], npcs: [structuredClone(anna)], locations: [structuredClone(cafe), structuredClone(park)],
  life: { ...emptyLifeChanges(), transfers: [{ ref: item.id, to, quantity: 2, accepted: true }] }, intent: "act", defaultMinutes: 0,
  turnNumber: 4, touchedItemIds: new Set(), mainQuestCompleted: false, makeId: () => "holding-new", ...patch,
});
function checkedApply(value: ApplyLifeInput) {
  const before = structuredClone({ ...value, makeId: undefined });
  const result = applyLife(value);
  assert.deepEqual({ ...value, makeId: undefined }, before, "planning must preserve all caller-owned state");
  assert.deepEqual(applyLife(value), result, "replanning the same snapshot must be deterministic");
  return result;
}
function assertRejected(value: ApplyLifeInput) {
  const result = checkedApply(value);
  assert.deepEqual(result.ops, []);
  assert.deepEqual(readLife(result.world).holdings, []);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.applied.transfers.map(({ name, to, quantity, ok }) => ({ name, to, quantity, ok })), [{ name: "Книга стихов", to: value.life.transfers[0].to, quantity: 2, ok: false }]);
  assert.equal(result.rejected.length, 1);
}

// Break caught: a display name encountered first stealing a stable NPC key.
for (const reverse of [false, true]) test(`exact NPC key owns the transfer despite a display-name collision (reversed=${reverse})`, () => {
  const impostor = { ...boris, name: "anna" };
  const result = checkedApply(input("anna", { npcs: reverse ? [anna, impostor] : [impostor, anna] }));
  assert.deepEqual(result.ops, [{ t: "inv.update", id: item.id, patch: { quantity: 1 } }]);
  assert.deepEqual(readLife(result.world).holdings, [{ id: "holding-new", name: "Книга стихов", description: "Томик с подписью", quantity: 2, holderKind: "npc", holderKey: "anna", holderName: "Анна", turn: 4 }]);
  assert.deepEqual(result.applied.transfers, [{ name: "Книга стихов", to: "Анна", quantity: 2, ok: true }]);
  assert.deepEqual(result.events.map(({ entityKey, content }) => ({ entityKey, content })), [{ entityKey: "holding:книга стихов", content: "Ход 4: герой передал «Книга стихов» ×2 — теперь предмет у Анна." }]);
});

// Break caught: a fuzzy mention stealing an exact display name.
test("an exact recipient name beats a different NPC mentioned inside that name", () => {
  const longer = { ...boris, name: "Анна Мария" };
  const result = checkedApply(input("Анна Мария", { npcs: [anna, longer] }));
  assert.deepEqual(readLife(result.world).holdings.map(({ holderKey, holderName }) => ({ holderKey, holderName })), [{ holderKey: "boris", holderName: "Анна Мария" }]);
  assert.deepEqual(result.applied.transfers, [{ name: "Книга стихов", to: "Анна Мария", quantity: 2, ok: true }]);
});

for (const reverse of [false, true]) {
  // Break caught: choosing the first duplicate display name, even if another row is unavailable.
  test(`duplicate NPC names reject without selecting an arbitrary recipient (reversed=${reverse})`, () => {
    const duplicate = { ...boris, name: "Анна", lastLocation: "Парк" };
    assertRejected(input("Анна", { npcs: reverse ? [duplicate, anna] : [anna, duplicate] }));
  });
  // Break caught: accepting the first of two NPCs named by an unresolved prose target.
  test(`prose naming two recipients rejects without spending the item (reversed=${reverse})`, () => {
    assertRejected(input("Анне или Борису", { npcs: reverse ? [boris, anna] : [anna, boris] }));
  });
  // Break caught: location name lookup shadowing a stable location identity.
  test(`a stable location ID beats another location named after that ID (reversed=${reverse})`, () => {
    const alias = { ...park, name: "cafe" };
    const result = checkedApply(input("cafe", { locations: reverse ? [cafe, alias] : [alias, cafe] }));
    assert.deepEqual(result.ops, [{ t: "inv.update", id: item.id, patch: { quantity: 1 } }]);
    assert.deepEqual(readLife(result.world).holdings.map(({ quantity, holderKind, holderKey, holderName }) => ({ quantity, holderKind, holderKey, holderName })), [{ quantity: 2, holderKind: "location", holderKey: "cafe", holderName: "Кафе" }]);
  });
}

for (const row of [
  { name: "unknown", to: "unknown-recipient", npcs: [anna] },
  { name: "dead", to: "anna", npcs: [{ ...anna, status: "dead" as const }] },
  { name: "missing despite a stale local lastLocation", to: "anna", npcs: [{ ...anna, status: "missing" as const }] },
  { name: "remote", to: "anna", npcs: [{ ...anna, lastLocation: "Парк" }] },
  { name: "remote location", to: "park", npcs: [anna] },
]) test(`${row.name} recipient leaves inventory, ownership and semantic memory unchanged`, () => assertRejected(input(row.to, { npcs: row.npcs })));

for (const row of [
  { name: "dead", recipient: { ...anna, status: "dead" as const } },
  { name: "missing", recipient: { ...anna, status: "missing" as const } },
  { name: "remote", recipient: { ...anna, lastLocation: "Парк" } },
]) test(`an exact ${row.name} recipient key cannot fall back to an available NPC named after that key`, () => {
  assertRejected(input("anna", { npcs: [{ ...boris, name: "anna" }, row.recipient] }));
});

// Positive controls keep exact names and supported case-inflected prose available.
for (const to of [" Анна ", "Анне", "Кафе"]) test(`supported unique recipient ${JSON.stringify(to)} transfers the accepted stack quantity`, () => {
  const result = checkedApply(input(to));
  assert.deepEqual(result.ops, [{ t: "inv.update", id: item.id, patch: { quantity: 1 } }]);
  assert.deepEqual(readLife(result.world).holdings.map(({ quantity, holderKind, holderKey }) => ({ quantity, holderKind, holderKey })), [{ quantity: 2, holderKind: to === "Кафе" ? "location" : "npc", holderKey: to === "Кафе" ? "cafe" : "anna" }]);
});

const holding = (patch: Partial<Holding> = {}): Holding => ({ id: "holding-anna", name: "Книга стихов", description: "Томик с подписью", quantity: 3, holderKind: "npc", holderKey: "anna", holderName: "Анна", turn: 2, ...patch });
for (const reverse of [false, true]) test(`a name-only acquisition cannot choose between two known holders (reversed=${reverse})`, () => {
  const first = holding(), second = holding({ id: "holding-boris", holderKey: "boris", holderName: "Борис", quantity: 2 });
  const holdings = reverse ? [second, first] : [first, second];
  const result = checkedApply(input("", { world: { ...world(), holdings }, npcs: [anna, boris], inventory: [], life: emptyLifeChanges(), addedItems: [{ name: "Книга стихов", quantity: 1 }] }));
  assert.deepEqual(readLife(result.world).holdings, holdings);
  assert.deepEqual(result.events, [], "a generic add proves acquisition, not which holding supplied it");
  assert.deepEqual(result.ops, []);
});

test("a name-only acquisition does not infer the source by filtering out a remote same-name holding", () => {
  const holdings = [holding(), holding({ id: "holding-park", holderKind: "location", holderKey: "park", holderName: "Парк", quantity: 2 })];
  const result = checkedApply(input("", { world: { ...world(), holdings }, inventory: [], life: emptyLifeChanges(), addedItems: [{ name: "Книга стихов", quantity: 1 }] }));
  assert.deepEqual(readLife(result.world).holdings, holdings);
  assert.deepEqual(result.events, []);
});

test("an inaccessible location holding is not consumed by a generic same-name acquisition", () => {
  const holdings = [holding({ holderKind: "location", holderKey: "park", holderName: "Парк" })];
  const result = checkedApply(input("", { world: { ...world(), holdings }, inventory: [], life: emptyLifeChanges(), addedItems: [{ name: "Книга стихов", quantity: 1 }] }));
  assert.deepEqual(readLife(result.world).holdings, holdings);
  assert.deepEqual(result.events, []);
});

// Existing accepted-add protocol can represent a courier return; presence is not authoritative source provenance.
test("a supported singleton NPC acquisition preserves partial-return provenance even when the holder is remote", () => {
  const result = checkedApply(input("", { world: { ...world(), holdings: [holding()] }, inventory: [], npcs: [{ ...anna, lastLocation: "Парк" }], life: emptyLifeChanges(), addedItems: [{ name: "Книга стихов", quantity: 2 }] }));
  assert.deepEqual(readLife(result.world).holdings, [{ id: "holding-anna", name: "Книга стихов", description: "Томик с подписью", quantity: 1, holderKind: "npc", holderKey: "anna", holderName: "Анна", turn: 2 }]);
  assert.deepEqual(result.events.map(({ entityKey, content }) => ({ entityKey, content })), [{ entityKey: "holding:книга стихов", content: "Ход 4: «Книга стихов» ×2 вернулся к герою (был у Анна)." }]);
});

test("performTurn persists stable recipient identity and preserves ambiguous ownership", async t => {
  const fixture = await accountsDb();
  const { pg } = fixture;
  const { performTurn } = await import("../src/lib/turn");
  const character: CharacterState = { name: "Ада", archetype: "Горожанка", level: 1, xp: 0, hp: 20, maxHp: 20, gold: 5, stats: {}, skills: [], traits: [], conditions: [], backstory: "", appearance: "" };
  const config: AIConfig = { keys: [], dbKeyCount: 0, envKeyCount: 0, useLiveAI: true, canUseLive: true, textProvider: "openrouter", textModel: "synthetic/story", textApiKey: "synthetic-transfer-key", routingConfig: { profile: "balanced", narrationModel: "gemini-3.5-flash-lite", customActionModel: "gemini-3.8-flash", compactionModel: "gemini-3.8-flash", fastTaskModel: "gemini-3.5-flash-lite" }, limits: { flash: 20, lite: 500 }, enforceLimits: false, embeddingsEnabled: false, embeddingModel: "gemini-embedding-2", embeddingDims: 768, semanticExtractionEnabled: true };
  const create = async (savedWorld: WorldState, quantity = 3) => {
    const sessionId = randomUUID(), itemId = randomUUID();
    await pg.query("INSERT INTO game_sessions(id,title,campaign_mode,rules_profile,character,world_state,turn_count,owner_id) VALUES ($1,'Identity fixture','free','narrative',$2,$3,1,'transfer-fixture')", [sessionId, JSON.stringify(character), JSON.stringify(savedWorld)]);
    await pg.query("INSERT INTO inventory_items(id,session_id,name,kind,quantity,description) VALUES ($1,$2,'Книга стихов','misc',$3,'Томик с подписью')", [itemId, sessionId, quantity]);
    return { sessionId, itemId };
  };
  const run = async (sessionId: string, changes: Record<string, unknown>, narration: string) => {
    const diagnostics: (() => Promise<void>)[] = [];
    const draft = { narration, choices: ["Продолжить разговор"], outcome: "neutral", effects: { hp: 0, xp: 0, gold: 0, danger: 0 }, stateChanges: { ...emptyChanges(), ...changes } };
    let calls = 0;
    const transport = mock.method(globalThis, "fetch", async (url: unknown) => {
      assert.equal(String(url), "https://openrouter.ai/api/v1/chat/completions");
      assert.equal(++calls, 1, "unexpected additional provider request");
      return Response.json({ choices: [{ message: { content: JSON.stringify(draft) }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10 } });
    });
    try {
      const result = await performTurn({ sessionId, expectedTurn: 1, requestId: randomUUID(), isFree: true, action: "Продолжить обмен книгами" }, { loadAIConfig: async () => config, loadNarrativeConfig: async () => ({ enabled: false, provider: "openrouter", apiKey: "" }), schedule() {}, scheduleDiagnostics: job => diagnostics.push(job) });
      for (const job of diagnostics) await job();
      assert.ok(result.ok, JSON.stringify(result));
      const saved = (await pg.query<{ world_state: WorldState; turn_count: number }>("SELECT world_state,turn_count FROM game_sessions WHERE id=$1", [sessionId])).rows[0];
      assert.equal(saved.turn_count, 2);
      assert.deepEqual(saved.world_state, result.state!.worldState);
      const turns = (await pg.query<{ content: string; state_changes: unknown }>("SELECT content,state_changes FROM game_turns WHERE session_id=$1 AND role='narrator' AND turn_number=2", [sessionId])).rows;
      assert.deepEqual(turns, [{ content: narration, state_changes: result.applied }]);
      return result;
    } finally { transport.mock.restore(); }
  };
  try {
    await t.test("the exact NPC key wins over a newer NPC with the colliding display name", async () => {
      const { sessionId, itemId } = await create(world());
      await pg.query("INSERT INTO npcs(session_id,key,name,status,last_location,last_seen_turn) VALUES ($1,'boris','anna','alive','Кафе',10),($1,'anna','Анна','alive','Кафе',1)", [sessionId]);
      const result = await run(sessionId, { transfers: [{ ref: itemId, to: "anna", quantity: 2, accepted: true }] }, "Ты передал Анне две книги стихов.");
      assert.deepEqual((await pg.query("SELECT id,quantity FROM inventory_items WHERE session_id=$1", [sessionId])).rows, [{ id: itemId, quantity: 1 }]);
      assert.deepEqual(readLife(result.state!.worldState).holdings.map(({ holderKey, holderName, quantity }) => ({ holderKey, holderName, quantity })), [{ holderKey: "anna", holderName: "Анна", quantity: 2 }]);
      assert.deepEqual(result.applied.life?.transfers, [{ name: "Книга стихов", to: "Анна", quantity: 2, ok: true }]);
      assert.deepEqual((await pg.query("SELECT source,source_turn,content FROM memory_nodes WHERE session_id=$1 AND entity_key='holding:книга стихов'", [sessionId])).rows, [{ source: "state", source_turn: 2, content: "Ход 2: герой передал «Книга стихов» ×2 — теперь предмет у Анна." }]);
    });
    await t.test("a duplicate recipient name preserves the last item and creates no ownership memory", async () => {
      const { sessionId, itemId } = await create(world(), 1);
      await pg.query("INSERT INTO npcs(session_id,key,name,status,last_location) VALUES ($1,'anna-1','Анна','alive','Кафе'),($1,'anna-2','Анна','alive','Кафе')", [sessionId]);
      const result = await run(sessionId, { transfers: [{ ref: itemId, to: "Анна", quantity: 1, accepted: true }] }, "Книга пока остаётся у тебя; нужно уточнить получателя.");
      assert.deepEqual((await pg.query("SELECT id,quantity FROM inventory_items WHERE session_id=$1", [sessionId])).rows, [{ id: itemId, quantity: 1 }]);
      assert.deepEqual(readLife(result.state!.worldState).holdings, []);
      assert.deepEqual(result.applied.life?.transfers.map(({ name, to, quantity, ok }) => ({ name, to, quantity, ok })), [{ name: "Книга стихов", to: "Анна", quantity: 1, ok: false }]);
      assert.deepEqual((await pg.query("SELECT entity_key FROM memory_nodes WHERE session_id=$1 AND entity_key='holding:книга стихов'", [sessionId])).rows, []);
    });
    await t.test("an accepted same-name acquisition preserves two holdings and their existing memory", async () => {
      const holdings = [holding({ turn: 1 }), holding({ id: "holding-boris", holderKey: "boris", holderName: "Борис", quantity: 2, turn: 1 })];
      const { sessionId, itemId } = await create({ ...world(), holdings }, 1);
      await pg.query("INSERT INTO npcs(session_id,key,name,status,last_location) VALUES ($1,'anna','Анна','alive','Кафе'),($1,'boris','Борис','alive','Кафе')", [sessionId]);
      await pg.query("INSERT INTO memory_nodes(session_id,layer,category,title,content,source,source_turn,entity_key) VALUES ($1,'semantic','item','Книги у друзей','У Анны три книги, у Бориса две.','state',1,'holding:книга стихов')", [sessionId]);
      const result = await run(sessionId, { inventory: [{ op: "add", ref: null, name: "Книга стихов", kind: "misc", description: "Новая покупка", quantity: 1 }] }, "Ты купил ещё одну книгу стихов в кафе.");
      assert.deepEqual((await pg.query("SELECT id,quantity FROM inventory_items WHERE session_id=$1", [sessionId])).rows, [{ id: itemId, quantity: 2 }]);
      assert.deepEqual(readLife(result.state!.worldState).holdings, holdings);
      assert.deepEqual(result.applied.inventory, [{ op: "add", name: "Книга стихов", quantity: 1, ok: true }]);
      assert.deepEqual((await pg.query("SELECT source,source_turn,content FROM memory_nodes WHERE session_id=$1 AND entity_key='holding:книга стихов'", [sessionId])).rows, [{ source: "state", source_turn: 1, content: "У Анны три книги, у Бориса две." }]);
    });
  } finally { await fixture.close(); }
});
