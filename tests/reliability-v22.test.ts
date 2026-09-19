import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readJsonObject, HttpError, expectedTurn, requestKey } from "../src/lib/http";
import { normalizeTurnInput, turnInputHash } from "../src/lib/turn-admission";
import { assertSnapshot, remapSnapshot, snapshotChecksum, stableSerialize } from "../src/lib/checkpoint-snapshot";
import type { CheckpointSnapshot } from "../src/lib/checkpoint-types";
import { textChunks } from "../src/lib/compaction";
import { readPendingTurn } from "../src/components/use-turn-request";
import { retryDelayMs } from "../src/lib/memory-jobs";
import { relevantInventory } from "../src/lib/context-budget";
const sourceId = "11111111-1111-4111-8111-111111111111";
function fixture(): CheckpointSnapshot {
  const id = randomUUID, date = new Date().toISOString(), itemId = id(), memoryA = id(), memoryB = id(), location = id();
  const character = { name: "Ада", archetype: "Исследователь", level: 1, xp: 0, hp: 0, maxHp: 0, mana: 0, maxMana: 0, gold: 0, stats: {}, skills: ["Анализ"], traits: [], backstory: "", appearance: "", conditions: [] };
  const worldState = { worldName: "Орбита", tone: "научная фантастика", era: "2200", mainQuest: "Найти сигнал", currentLocation: "Шлюз", factions: [], flags: { evidence: itemId }, danger: 20, chapter: 1 };
  const memory = { sessionId: sourceId, layer: "semantic", category: "world", title: "Ключ от шлюза", content: `Предмет item:${itemId} и ссылка #${itemId.slice(0, 6)} принадлежат герою.`, importance: 80, salience: 80, tokensEstimate: 30, turnFrom: 1, turnTo: 1,  source: "state" as const, sourceTurn: 1, contentHash: "old", entityKey: `item:${itemId}`, confidence: 1, evidence: null, createdAt: date, updatedAt: date };
  return {
    schemaVersion: 1,
    session: { id: sourceId, title: "Тестовый мир", scenarioId: "echo-station", scenarioTitle: "Эхо", scenarioPrompt: "Станция в космосе", campaignMode: "preset", rulesProfile: "narrative", character, worldState, status: "active", turnCount: 1, contextTokensEstimate: 100, lastCompactTurn: 0 },
    turns: [{ id: id(), sessionId: sourceId, turnNumber: 1, role: "narrator", content: "Вы у шлюза.", choices: ["Изучить сигнал"], dice: null, modelUsed: "preset-intro", taskType: "narration", promptTokens: 0, completionTokens: 20, requestId: "must-not-survive-fork", stateChanges: null, contextMeta: { model: "preset-intro", rulesProfile: "narrative", digestChars: 0, retrievedIds: [memoryA, memoryB] }, createdAt: date }],
    inventory: [{ id: itemId, sessionId: sourceId, name: "Ключ", kind: "key", description: "Открывает шлюз", quantity: 2, equipped: false, power: 0, icon: "🗝️", createdAt: date }],
    locations: [{ id: location, sessionId: sourceId, name: "Шлюз", description: "Начальная локация", x: 1, y: 1, current: true, discovered: true, danger: 20, icon: "🚪", connectedTo: [location] }],
    quests: [{ id: id(), sessionId: sourceId, key: "main", title: "Найти сигнал", description: "", status: "active", progress: 0, isMain: true, updatedTurn: 1, createdAt: date }],
    npcs: [{ id: id(), sessionId: sourceId, key: "navigator", name: "Навигатор", role: "Экипаж", description: "", relation: 10, status: "alive", lastSeenTurn: 1, lastLocation: "Шлюз", createdAt: date }],
    sceneObjects: [{ id: id(), sessionId: sourceId, key: "door", name: "Дверь", locationName: "Шлюз", state: "заперта", description: "", interactable: true, updatedTurn: 1, createdAt: date }],
    memories: [{ id: memoryA, ...memory, parentId: null }, { id: memoryB, ...memory, entityKey: "world:signal", parentId: memoryA }],
    links: [{ id: id(), fromId: memoryA, toId: memoryB, relation: "explains" }],
  };
}
test("v2.2 request validation rejects coercion, empty actions and malformed IDs", () => {
  assert.throws(() => normalizeTurnInput({ sessionId: sourceId, action: "   ", isFree: true }), HttpError);
  assert.throws(() => normalizeTurnInput({ sessionId: "not-uuid", action: "Осмотреться", isFree: true }), HttpError);
  assert.throws(() => normalizeTurnInput({ sessionId: sourceId, action: "Осмотреться", isFree: "false" as unknown as boolean }), HttpError);
  assert.throws(() => expectedTurn("2"), HttpError); assert.throws(() => expectedTurn(NaN), HttpError); assert.throws(() => expectedTurn(-1), HttpError);
  assert.throws(() => requestKey("x".repeat(81)), HttpError);
  assert.equal(normalizeTurnInput({ sessionId: sourceId, action: "  Осмотреться  ", isFree: true }).action, "Осмотреться");
});
test("v2.2 idempotency hash binds action, mode and base scene", () => {
  const a = { action: "Открыть дверь", isFree: true, expectedTurn: 4 };
  assert.equal(turnInputHash(a), turnInputHash({ ...a, action: ` ${a.action} ` }));
  for (const b of [{ ...a, isFree: false }, { ...a, expectedTurn: 5 }, { ...a, action: "Не открывать дверь" }]) assert.notEqual(turnInputHash(a), turnInputHash(b));
});
test("v2.2 JSON reader checks real streamed size without trusting Content-Length", async () => {
  const request = new Request("https://app.test/api", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "1" }, body: JSON.stringify({ action: "я".repeat(100) }) });
  await assert.rejects(readJsonObject(request, 100), (e: unknown) => e instanceof HttpError && e.status === 413);
  for (const body of ["null", "[]", "broken", "42"]) await assert.rejects(readJsonObject(new Request("https://app.test", { method: "POST", headers: { "Content-Type": "application/json" }, body })), HttpError);
  const valid = await readJsonObject(new Request("https://app.test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "Вперёд" }) })); assert.equal(valid.action, "Вперёд");
});
test("v2.2 pending request parsing survives reload but ignores corrupted or foreign storage", () => {
  const p = { id: randomUUID(), sessionId: sourceId, action: "Поговорить", custom: true, expectedTurn: 2 };
  assert.deepEqual(readPendingTurn(JSON.stringify(p), sourceId), p);
  assert.equal(readPendingTurn(JSON.stringify(p), randomUUID()), null);
  assert.equal(readPendingTurn("broken", sourceId), null);
  assert.equal(readPendingTurn(JSON.stringify({ ...p, expectedTurn: "2" }), sourceId), null);
});
test("v2.2 canonical checksum is independent of PostgreSQL JSONB key order", () => {
  assert.equal(stableSerialize({ b: 1, a: { d: 2, c: [3, 4] } }), stableSerialize({ a: { c: [3, 4], d: 2 }, b: 1 }));
  const s = fixture(); const copy = JSON.parse(JSON.stringify(s)) as CheckpointSnapshot;
  assert.equal(snapshotChecksum(s), snapshotChecksum(copy)); copy.inventory[0].quantity = 1; assert.notEqual(snapshotChecksum(s), snapshotChecksum(copy));
});
test("v2.2 fork remaps all identities, canonical refs, links and retrieval provenance", () => {
  const s = fixture(), before = JSON.stringify(s), branchId = randomUUID();
  const branch = remapSnapshot(s, branchId);
  assert.equal(JSON.stringify(s), before, "original immutable snapshot is not modified");
  assert.equal(branch.session.id, branchId);
  assert.notEqual(branch.inventory[0].id, s.inventory[0].id);
  assert.equal(branch.inventory[0].quantity, 2);
  assert.equal(branch.session.worldState.flags.evidence, branch.inventory[0].id);
  assert.equal(branch.memories[0].entityKey, `item:${branch.inventory[0].id}`);
  assert.ok(branch.memories[0].content.includes(`#${branch.inventory[0].id.slice(0, 6)}`));
  assert.equal(branch.memories[1].parentId, branch.memories[0].id);
  assert.equal(branch.links[0].fromId, branch.memories[0].id); assert.equal(branch.links[0].toId, branch.memories[1].id);
  assert.equal(branch.turns[0].requestId, null);
  assert.deepEqual(branch.turns[0].contextMeta?.retrievedIds, branch.memories.map((m) => m.id));
  assert.equal(branch.locations[0].connectedTo?.[0], branch.locations[0].id);
  assert.ok(!JSON.stringify(branch).includes(s.inventory[0].id));
  assertSnapshot(branch);
});
for (const corruption of ["future-memory", "foreign-item", "wrong-location", "duplicate-identity", "external-link", "missing-last-turn", "new-format"]) test(`v2.2 snapshot rejects ${corruption}`, () => {
  const s = fixture();
  if (corruption === "future-memory") s.memories[0].sourceTurn = 2;
  if (corruption === "foreign-item") s.inventory[0].sessionId = randomUUID();
  if (corruption === "wrong-location") s.locations[0].name = "Другая локация";
  if (corruption === "duplicate-identity") s.npcs[0].id = s.inventory[0].id;
  if (corruption === "external-link") s.links[0].toId = randomUUID();
  if (corruption === "missing-last-turn") s.turns = [];
  if (corruption === "new-format") s.schemaVersion = 2 as 1;
  assert.throws(() => assertSnapshot(s), HttpError);
});
test("v2.2 compaction chunks preserve all text without splitting Unicode surrogate pairs", () => {
  const text = "Событие 🌌 и выбор героя. ".repeat(500);
  const chunks = textChunks(text);
  assert.equal(chunks.join(""), text); assert.ok(chunks.every((c) => c.length <= 740));
  assert.ok(chunks.every((c) => !/[\uD800-\uDBFF]$/.test(c) && !/^[\uDC00-\uDFFF]/.test(c)));
});
test("v2.2 queue retries use bounded exponential backoff", () => {
  assert.equal(retryDelayMs(1), 10000); assert.equal(retryDelayMs(2), 20000); assert.equal(retryDelayMs(3), 40000); assert.ok(retryDelayMs(999) <= 300000);
});

test("v2.2 inventory context pins an explicitly referenced item beyond the first fourteen", () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ id: randomUUID(), name: `Инструмент ${i}`, kind: i < 14 ? "quest" : "tool", quantity: 1, equipped: false, description: "" }));
  const selected = relevantInventory(items, `Использовать #${items[24].id.slice(0, 6)}`);
  assert.equal(selected.length, 14); assert.equal(selected[0].id, items[24].id);
  assert.equal(relevantInventory(items, items[23].name)[0].id, items[23].id);
  items[24].quantity = 0; assert.ok(!relevantInventory(items, items[24].id).some((item) => item.id === items[24].id));
});
