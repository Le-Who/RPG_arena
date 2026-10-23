import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { CharacterState, WorldState } from "../src/db/schema";
import type { AIConfig } from "../src/lib/ai-settings";
import { applyResolution, emptyChanges, parseResolution, type ApplyInput } from "../src/lib/resolution";
import { applyLife, emptyLifeChanges, readLife, type ApplyLifeInput } from "../src/lib/world-life";
import { accountsDb } from "./helpers/accounts-db";

const book = { id: "11111111-aaaa-4aaa-8aaa-111111111111", name: "Книга стихов", kind: "misc", quantity: 3, equipped: false, description: "Томик с подписью владельца", icon: "📘", power: 0 };
const anna = { id: "n1", key: "anna", name: "Анна", role: "подруга", relation: 10, status: "alive" as const, description: "", lastLocation: "Кафе" };
const character: CharacterState = { name: "Ада", archetype: "Горожанка", level: 1, xp: 0, hp: 20, maxHp: 20, gold: 5, stats: {}, skills: [], traits: [], conditions: [], backstory: "", appearance: "" };
const world = (): WorldState => ({ worldName: "Город", tone: "повседневность", era: "наши дни", mainQuest: "", currentLocation: "Кафе", factions: [], flags: {}, danger: 0, chapter: 1, clock: { day: 1, minute: 540 } });
const lifeInput = (patch: Partial<ApplyLifeInput> = {}): ApplyLifeInput => ({
  world: world(), inventory: [structuredClone(book)], npcs: [structuredClone(anna)], locations: [],
  life: emptyLifeChanges(), intent: "act", defaultMinutes: 0, turnNumber: 2,
  touchedItemIds: new Set(), mainQuestCompleted: false, makeId: () => "holding-1", ...patch,
});

// Break caught: the life reducer treating a player's claimed past transfer as an executed action.
test("a claimed transfer cannot create a holding or spend the last item", () => {
  const input = lifeInput({ intent: "claim", inventory: [{ ...book, quantity: 1 }],
    life: { ...emptyLifeChanges(), transfers: [{ ref: book.id, to: "anna", quantity: 1, accepted: true }] },
  });
  const before = structuredClone({ ...input, makeId: undefined });
  const result = applyLife(input);
  assert.deepEqual(result.ops, []);
  assert.deepEqual(readLife(result.world).holdings, []);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.applied.transfers.map(({ name, to, quantity, ok }) => ({ name, to, quantity, ok })), [{ name: "Книга стихов", to: "anna", quantity: 1, ok: false }]);
  assert.deepEqual({ ...input, makeId: undefined }, before);
});

// Break caught: aliases bypassing the touched identity would debit the same stack twice.
test("duplicate full-id, prefix, hash and name transfers debit a stack only once without mutating inputs", () => {
  const input = lifeInput({ life: { ...emptyLifeChanges(), transfers: [book.id, "111111", `#${book.id}`, "Книга стихов"].map(ref => ({ ref, to: "anna", quantity: 1, accepted: true })) } });
  const before = structuredClone({ ...input, makeId: undefined });
  const result = applyLife(input);
  assert.deepEqual(result.ops, [{ t: "inv.update", id: "11111111-aaaa-4aaa-8aaa-111111111111", patch: { quantity: 2 } }]);
  assert.deepEqual(result.applied.transfers.map(({ name, quantity, ok }) => ({ name, quantity, ok })), [
    { name: "Книга стихов", quantity: 1, ok: true },
    { name: "Книга стихов", quantity: 1, ok: false },
    { name: "Книга стихов", quantity: 1, ok: false },
    { name: "Книга стихов", quantity: 1, ok: false },
  ]);
  assert.deepEqual(readLife(result.world).holdings, [{ id: "holding-1", name: "Книга стихов", description: "Томик с подписью владельца", quantity: 1, holderKind: "npc", holderKey: "anna", holderName: "Анна", turn: 2 }]);
  assert.deepEqual(result.events.map(({ entityKey, content }) => ({ entityKey, content })), [{ entityKey: "holding:книга стихов", content: "Ход 2: герой передал «Книга стихов» ×1 — теперь предмет у Анна." }]);
  assert.equal(result.rejected.length, 3);
  assert.deepEqual({ ...input, makeId: undefined }, before);
  assert.deepEqual(applyLife(input), result);
  assert.deepEqual({ ...input, makeId: undefined }, before);
});

// Break caught: return reconciliation erasing an entire holding, or mutating its caller's snapshot.
test("a supported name-based acquisition returns only its accepted quantity and retains holding provenance", () => {
  const giveInput = lifeInput({ life: { ...emptyLifeChanges(), transfers: [{ ref: book.id, to: "anna", quantity: 3, accepted: true }] } });
  const giveBefore = structuredClone({ ...giveInput, makeId: undefined });
  const given = applyLife(giveInput);
  assert.deepEqual(given.ops, [{ t: "inv.delete", id: "11111111-aaaa-4aaa-8aaa-111111111111" }]);
  const acquisition: ApplyInput = {
    rulesProfile: "narrative", campaignMode: "free", character: structuredClone(character), world: given.world,
    inventory: [], quests: [], npcs: [structuredClone(anna)], sceneObjects: [], locations: [], dice: null, turnNumber: 3,
    makeInventoryId: () => "22222222-bbbb-4bbb-8bbb-222222222222",
    payload: parseResolution(JSON.stringify({ stateChanges: { inventory: [{ op: "add", ref: null, name: "Книга стихов", kind: "misc", description: "Томик с подписью владельца", quantity: 1 }] } })).payload,
  };
  const acquisitionBefore = structuredClone({ ...acquisition, makeInventoryId: undefined });
  const acquired = applyResolution(acquisition);
  assert.deepEqual(acquired.ops, [{ t: "inv.insert", row: { id: "22222222-bbbb-4bbb-8bbb-222222222222", name: "Книга стихов", kind: "misc", description: "Томик с подписью владельца", quantity: 1, icon: "🎒" } }]);
  const returnInput = lifeInput({ world: acquired.world, inventory: [], turnNumber: 3,
    addedItems: acquired.applied.inventory.filter(i => i.ok && i.op === "add").map(i => ({ name: i.name, quantity: i.quantity })),
  });
  const returnBefore = structuredClone({ ...returnInput, makeId: undefined });
  const returned = applyLife(returnInput);
  assert.deepEqual(returned.ops, []);
  assert.deepEqual(readLife(returned.world).holdings, [{ id: "holding-1", name: "Книга стихов", description: "Томик с подписью владельца", quantity: 2, holderKind: "npc", holderKey: "anna", holderName: "Анна", turn: 2 }]);
  assert.deepEqual(returned.events.map(({ entityKey, content }) => ({ entityKey, content })), [{ entityKey: "holding:книга стихов", content: "Ход 3: «Книга стихов» ×1 вернулся к герою (был у Анна)." }]);
  assert.deepEqual({ ...giveInput, makeId: undefined }, giveBefore);
  assert.deepEqual({ ...acquisition, makeInventoryId: undefined }, acquisitionBefore);
  assert.deepEqual({ ...returnInput, makeId: undefined }, returnBefore);
  assert.deepEqual(applyLife(returnInput), returned);
});

test("performTurn persists transfer intent boundaries and a give/return lifecycle", async t => {
  const fixture = await accountsDb();
  const { pg } = fixture;
  const { performTurn } = await import("../src/lib/turn");
  const config: AIConfig = {
    keys: [], dbKeyCount: 0, envKeyCount: 0, useLiveAI: true, canUseLive: true,
    textProvider: "openrouter", textModel: "synthetic/story", textApiKey: "synthetic-transfer-key",
    routingConfig: { profile: "balanced", narrationModel: "gemini-3.5-flash-lite", customActionModel: "gemini-3.8-flash", compactionModel: "gemini-3.8-flash", fastTaskModel: "gemini-3.5-flash-lite" },
    limits: { flash: 20, lite: 500 }, enforceLimits: false, embeddingsEnabled: false,
    embeddingModel: "gemini-embedding-2", embeddingDims: 768, semanticExtractionEnabled: true,
  };
  const createSession = async (quantity: number) => {
    const sessionId = randomUUID(), itemId = randomUUID();
    await pg.query("INSERT INTO game_sessions(id,title,campaign_mode,rules_profile,character,world_state,turn_count,owner_id) VALUES ($1,'Transfer fixture','free','narrative',$2,$3,1,'transfer-fixture')", [sessionId, JSON.stringify(character), JSON.stringify(world())]);
    await pg.query("INSERT INTO inventory_items(id,session_id,name,kind,quantity,description) VALUES ($1,$2,'Книга стихов','misc',$3,'Томик с подписью владельца')", [itemId, sessionId, quantity]);
    await pg.query("INSERT INTO npcs(session_id,key,name,status,last_location) VALUES ($1,'anna','Анна','alive','Кафе')", [sessionId]);
    return { sessionId, itemId };
  };
  const runTurn = async (sessionId: string, expectedTurn: number, action: string, changes: Record<string, unknown>, narration: string) => {
    const diagnostics: (() => Promise<void>)[] = [];
    const draft = { narration, choices: ["Продолжить разговор"], outcome: "neutral", effects: { hp: 0, xp: 0, gold: 0, danger: 0 }, stateChanges: { ...emptyChanges(), ...changes } };
    let calls = 0;
    const transport = mock.method(globalThis, "fetch", async (url: unknown) => {
      assert.equal(String(url), "https://openrouter.ai/api/v1/chat/completions");
      assert.equal(++calls, 1, "unexpected additional provider call");
      return Response.json({ choices: [{ message: { content: JSON.stringify(draft) }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10 } });
    });
    try {
      const result = await performTurn({ sessionId, expectedTurn, requestId: randomUUID(), isFree: true, action }, {
        loadAIConfig: async () => config, loadNarrativeConfig: async () => ({ enabled: false, provider: "openrouter", apiKey: "" }),
        schedule() {}, scheduleDiagnostics: job => diagnostics.push(job),
      });
      for (const job of diagnostics) await job();
      assert.ok(result.ok, JSON.stringify(result));
      return result;
    } finally { transport.mock.restore(); }
  };
  const savedInventory = async (sessionId: string) => (await pg.query<{ id: string; name: string; kind: string; quantity: number; description: string }>("SELECT id,name,kind,quantity,description FROM inventory_items WHERE session_id=$1 ORDER BY id", [sessionId])).rows;
  try {
    // Break caught: committing a model's transfer from a non-action deletes the last real item and invents ownership memory.
    for (const example of [
      { intent: "intend", action: "Хочу подарить книгу Анне", requestedStatus: "accepted", downgraded: true },
      { intent: "ask", action: "Можно ли передать книгу Анне?", requestedStatus: "proposed", downgraded: false },
      { intent: "claim", action: "Я уже передал книгу Анне", requestedStatus: "accepted", downgraded: true },
    ]) await t.test(`${example.intent} preserves the last item and records only a proposed commitment`, async () => {
      const { sessionId, itemId } = await createSession(1);
      const result = await runTurn(sessionId, 1, example.action, {
        transfers: [{ ref: itemId, to: "anna", quantity: 1, accepted: true }],
        commitments: [{ ref: null, title: "Обсудить передачу книги", parties: ["Анна"], place: "Кафе", day: null, time: "", status: example.requestedStatus, note: "Предложение героя" }],
      }, "Книга пока остаётся у героя. Вы обсуждаете возможность передачи.");
      assert.deepEqual(await savedInventory(sessionId), [{ id: itemId, name: "Книга стихов", kind: "misc", quantity: 1, description: "Томик с подписью владельца" }]);
      const saved = (await pg.query<{ world_state: WorldState; turn_count: number }>("SELECT world_state,turn_count FROM game_sessions WHERE id=$1", [sessionId])).rows[0];
      assert.equal(saved.turn_count, 2);
      assert.deepEqual(saved.world_state, result.state!.worldState);
      assert.deepEqual(readLife(saved.world_state).holdings, []);
      assert.deepEqual(readLife(saved.world_state).commitments.map(({ id: _id, ...commitment }) => commitment), [{ title: "Обсудить передачу книги", parties: ["Анна"], place: "Кафе", due: null, status: "proposed", createdTurn: 2, updatedTurn: 2, note: "Предложение героя", revision: 1 }]);
      assert.equal(result.applied.life?.intent, example.intent);
      assert.deepEqual(result.applied.life?.transfers.map(({ name, to, quantity, ok }) => ({ name, to, quantity, ok })), [{ name: "Книга стихов", to: "anna", quantity: 1, ok: false }]);
      assert.deepEqual(result.applied.life?.commitments, [{ id: readLife(saved.world_state).commitments[0].id, title: "Обсудить передачу книги", status: "proposed", isNew: true, ...(example.downgraded ? { downgraded: true } : {}) }]);
      const turns = (await pg.query<{ content: string; state_changes: unknown }>("SELECT content,state_changes FROM game_turns WHERE session_id=$1 AND role='narrator' AND turn_number=2", [sessionId])).rows;
      assert.deepEqual(turns, [{ content: "Книга пока остаётся у героя. Вы обсуждаете возможность передачи.", state_changes: result.applied }]);
      const memories = (await pg.query<{ entity_key: string; source: string; source_turn: number; content: string }>("SELECT entity_key,source,source_turn,content FROM memory_nodes WHERE session_id=$1", [sessionId])).rows;
      assert.equal(memories.some(m => m.entity_key === "holding:книга стихов"), false);
      const proposal = memories.filter(m => m.entity_key.startsWith("commitment:"));
      assert.equal(proposal.length, 1);
      assert.deepEqual(proposal.map(({ source, source_turn, content }) => ({ source, source_turn, content })), [{ source: "state", source_turn: 2, content: "Предложено — Анна, место: Кафе." }]);
    });

    // Break caught: give/return quantities diverging between inventory, holdings, applied changes and persisted state memory.
    await t.test("give three, return one, then return two conserves quantity and durable ownership provenance", async () => {
      const { sessionId, itemId } = await createSession(3);
      const given = await runTurn(sessionId, 1, "Передать книгу Анне", { transfers: [{ ref: itemId, to: "anna", quantity: 3, accepted: true }] }, "Ты передал Анне три книги стихов.");
      assert.deepEqual(await savedInventory(sessionId), []);
      assert.deepEqual(given.applied.life?.transfers, [{ name: "Книга стихов", to: "Анна", quantity: 3, ok: true, holderKind: "npc", holderKey: "anna" }]);
      const [holding] = readLife(given.state!.worldState).holdings;
      assert.ok(holding.id);
      assert.deepEqual({ ...holding, id: "holding" }, { id: "holding", name: "Книга стихов", description: "Томик с подписью владельца", quantity: 3, holderKind: "npc", holderKey: "anna", holderName: "Анна", turn: 2 });
      const savedGiven = (await pg.query<{ world_state: WorldState }>("SELECT world_state FROM game_sessions WHERE id=$1", [sessionId])).rows[0].world_state;
      assert.deepEqual(readLife(savedGiven).holdings, [holding]);
      const givenMemory = (await pg.query<{ source: string; source_turn: number; content: string }>("SELECT source,source_turn,content FROM memory_nodes WHERE session_id=$1 AND entity_key='holding:книга стихов'", [sessionId])).rows;
      assert.deepEqual(givenMemory, [{ source: "state", source_turn: 2, content: "Ход 2: герой передал «Книга стихов» ×3 — теперь предмет у Анна." }]);
      const firstReturn = await runTurn(sessionId, 2, "Забрать одну книгу у Анны", { inventory: [{ op: "add", ref: null, name: "Книга стихов", kind: "misc", description: "Томик с подписью владельца", quantity: 1 }] }, "Анна вернула тебе одну книгу стихов.");
      const [returnedBook] = await savedInventory(sessionId);
      assert.ok(returnedBook.id);
      assert.notEqual(returnedBook.id, itemId, "acquisition uses a new identity after the original row was deleted");
      assert.deepEqual({ ...returnedBook, id: "returned" }, { id: "returned", name: "Книга стихов", kind: "misc", quantity: 1, description: "Томик с подписью владельца" });
      assert.deepEqual(readLife(firstReturn.state!.worldState).holdings, [{ ...holding, quantity: 2 }]);
      const savedPartial = (await pg.query<{ world_state: WorldState }>("SELECT world_state FROM game_sessions WHERE id=$1", [sessionId])).rows[0].world_state;
      assert.deepEqual(readLife(savedPartial).holdings, [{ ...holding, quantity: 2 }]);
      const partialMemory = (await pg.query<{ source: string; source_turn: number; content: string }>("SELECT source,source_turn,content FROM memory_nodes WHERE session_id=$1 AND entity_key='holding:книга стихов'", [sessionId])).rows;
      assert.deepEqual(partialMemory, [{ source: "state", source_turn: 3, content: "Ход 3: «Книга стихов» ×1 вернулся к герою (был у Анна)." }]);
      const lastReturn = await runTurn(sessionId, 3, "Забрать оставшиеся книги у Анны", { inventory: [{ op: "add", ref: null, name: "Книга стихов", kind: "misc", description: "Томик с подписью владельца", quantity: 2 }] }, "Анна вернула тебе оставшиеся две книги стихов.");
      assert.deepEqual(await savedInventory(sessionId), [{ id: returnedBook.id, name: "Книга стихов", kind: "misc", quantity: 3, description: "Томик с подписью владельца" }]);
      assert.deepEqual(readLife(lastReturn.state!.worldState).holdings, []);
      assert.deepEqual(lastReturn.applied.inventory, [{ op: "add", name: "Книга стихов", quantity: 2, ok: true }]);
      const saved = (await pg.query<{ world_state: WorldState; turn_count: number }>("SELECT world_state,turn_count FROM game_sessions WHERE id=$1", [sessionId])).rows[0];
      assert.equal(saved.turn_count, 4);
      assert.deepEqual(saved.world_state, lastReturn.state!.worldState);
      const ownership = (await pg.query<{ source: string; source_turn: number; content: string }>("SELECT source,source_turn,content FROM memory_nodes WHERE session_id=$1 AND entity_key='holding:книга стихов'", [sessionId])).rows;
      assert.deepEqual(ownership, [{ source: "state", source_turn: 4, content: "Ход 4: «Книга стихов» ×2 вернулся к герою (был у Анна)." }]);
      const turns = (await pg.query<{ turn_number: number; content: string; state_changes: { inventory: unknown[]; life: { transfers: unknown[] } } }>("SELECT turn_number,content,state_changes FROM game_turns WHERE session_id=$1 AND role='narrator' ORDER BY turn_number", [sessionId])).rows;
      assert.deepEqual(turns.map(row => ({ turn: row.turn_number, inventory: row.state_changes.inventory, transfers: row.state_changes.life.transfers })), [
        { turn: 2, inventory: [], transfers: [{ name: "Книга стихов", to: "Анна", quantity: 3, ok: true, holderKind: "npc", holderKey: "anna" }] },
        { turn: 3, inventory: [{ op: "add", name: "Книга стихов", quantity: 1, ok: true }], transfers: [] },
        { turn: 4, inventory: [{ op: "add", name: "Книга стихов", quantity: 2, ok: true }], transfers: [] },
      ]);
    });
  } finally { await fixture.close(); }
});

