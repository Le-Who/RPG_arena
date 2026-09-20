import { smokeFetch, smokeOwnerId, cleanupSmokeIdentity } from "./smoke-identity";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, pool } from "../src/db";
import { campaignCheckpoints, gameSessions, gameTurns, inventoryItems, memoryEmbeddings, memoryJobs, memoryLinks, memoryNodes, npcs, sceneObjects, tokenLogs, turnRequests } from "../src/db/schema";
import { acquireTurn, assertTurnLease, failTurnRequest, getTurnRequest, normalizeTurnInput } from "../src/lib/turn-admission";
import { performTurn } from "../src/lib/turn";
import { getAIConfig } from "../src/lib/ai-settings";
import { enqueueSemanticJob, processSemanticJob } from "../src/lib/memory-jobs";
import { runMemoryCycle } from "../src/lib/background";
import { upsertMemoryNode } from "../src/lib/memory";
import { compactSession } from "../src/lib/compaction";
import { searchMemory } from "../src/lib/embeddings";
import type { Session, Snapshot } from "../src/lib/ui-data";
const base = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const nativeFetch = globalThis.fetch;
const owned: string[] = [];
async function call<T = Record<string, unknown>>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const response = await smokeFetch(base + path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() as T };
}
async function create(scenarioId: string) {
  const made = await call<{ session: Session }>("/api/sessions", { mode: "preset", scenarioId, characterIndex: 0 });
  assert.equal(made.status, 200, JSON.stringify(made.data)); owned.push(made.data.session.id); return made.data.session;
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
async function run() {
  const config = await getAIConfig(smokeOwnerId);
  assert.ok(!config.canUseLive && !config.keys.length, "Run in a disposable offline workspace: never replace configured provider credentials.");
  const fakeConfig = { ...config, keys: ["mock-provider-not-a-real-key"], canUseLive: true, useLiveAI: true, enforceLimits: false };
  const source = await create("echo-station");
  let emptyIndexCalls = 0;
  globalThis.fetch = async () => { emptyIndexCalls++; throw new Error("The empty index must not call a provider"); };
  const emptySearch = await searchMemory({ sessionId: source.id, query: "Кто ждёт у шлюза?", keys: fakeConfig.keys, model: fakeConfig.embeddingModel, dims: fakeConfig.embeddingDims });
  assert.equal(emptySearch.results.length, 0); assert.equal(emptyIndexCalls, 0);
  globalThis.fetch = nativeFetch;
  const [extraItem] = await db.insert(inventoryItems).values({ sessionId: source.id, name: "Тестовый ключ", kind: "key", quantity: 2, description: "Не должен наследовать будущий расход" }).returning();
  const [npc] = await db.insert(npcs).values({ sessionId: source.id, key: "test-navigator", name: "Навигатор", relation: 10, lastSeenTurn: 1 }).returning();
  const [scene] = await db.insert(sceneObjects).values({ sessionId: source.id, key: "test-door", name: "Дверь", state: "заперта", locationName: source.worldState.currentLocation, updatedTurn: 1 }).returning();
  const firstFact = await upsertMemoryNode({ sessionId: source.id, layer: "semantic", category: "item", entityKey: `item:${extraItem.id}`, title: "Ключ найден", content: `Ключ #${extraItem.id.slice(0, 6)} (${extraItem.id}) хранится у героя.`, importance: 85, source: "state", sourceTurn: 1 });
  const secondFact = await upsertMemoryNode({ sessionId: source.id, layer: "semantic", category: "npc", entityKey: "npc:test-navigator", title: "Навигатор доверяет", content: "Навигатор доверяет герою и ждёт решения у шлюза.", importance: 75, source: "state", sourceTurn: 1 });
  await db.update(memoryNodes).set({ parentId: firstFact.id }).where(eq(memoryNodes.id, secondFact.id));
  await db.insert(memoryLinks).values({ fromId: firstFact.id, toId: secondFact.id, relation: "supports" });
  const pointRequest = { title: "Перед дверью", expectedTurn: 1, requestId: randomUUID() };
  const saved = await call<{ checkpoint: { id: string }; replay: boolean }>(`/api/sessions/${source.id}/checkpoints`, pointRequest);
  assert.equal(saved.status, 201, JSON.stringify(saved.data)); const pointId = saved.data.checkpoint.id;
  assert.equal((await call(`/api/sessions/${source.id}/checkpoints`, pointRequest)).data.replay, true);
  assert.equal((await call(`/api/sessions/${source.id}/checkpoints`, { ...pointRequest, title: "Другая точка" })).status, 409);
  const advanced = await call(`/api/sessions/${source.id}/act`, { action: "Открыть дверь", custom: true, requestId: randomUUID(), expectedTurn: 1 });
  assert.equal(advanced.status, 200, JSON.stringify(advanced.data));
  await db.update(inventoryItems).set({ quantity: 1 }).where(eq(inventoryItems.id, extraItem.id));
  await db.update(npcs).set({ relation: 50, lastSeenTurn: 2 }).where(eq(npcs.id, npc.id));
  await db.update(sceneObjects).set({ state: "открыта", updatedTurn: 2 }).where(eq(sceneObjects.id, scene.id));
  await upsertMemoryNode({ sessionId: source.id, layer: "semantic", category: "world", entityKey: "test:future", title: "Будущий факт", content: "Этот факт появился после сохранения контрольной точки.", importance: 90, source: "state", sourceTurn: 2 });
  const forkInput = { title: "Если бы дверь осталась закрытой", requestId: randomUUID() };
  const fork = await call<{ session: Session; replay: boolean }>(`/api/sessions/${source.id}/checkpoints/${pointId}/fork`, forkInput);
  assert.equal(fork.status, 201, JSON.stringify(fork.data)); owned.push(fork.data.session.id);
  const branch = (await call<Snapshot>(`/api/sessions/${fork.data.session.id}`)).data;
  assert.equal(branch.session.turnCount, 1); assert.equal(branch.session.branchOrigin?.turn, 1);
  assert.equal(branch.inventory.find((i) => i.name === extraItem.name)?.quantity, 2);
  assert.ok(branch.inventory.every((i) => i.id !== extraItem.id && i.sessionId === branch.session.id));
  assert.equal(branch.npcs.find((n) => n.key === npc.key)?.relation, 10);
  assert.equal(branch.sceneObjects.find((o) => o.key === scene.key)?.state, "заперта");
  assert.ok(branch.memories.every((m) => (m.sourceTurn ?? 0) <= 1)); assert.ok(!branch.memories.some((m) => m.title === "Будущий факт"));
  assert.equal(branch.embeddings?.pending, branch.memories.length);
  assert.ok(branch.turns.every((turn) => !turn.requestId));
  const newItem = branch.inventory.find((i) => i.name === extraItem.name)!;
  const copiedFact = branch.memories.find((m) => m.title === "Ключ найден")!;
  assert.equal(copiedFact.entityKey, `item:${newItem.id}`); assert.ok(copiedFact.content.includes(newItem.id));
  assert.equal(branch.memories.find((m) => m.title === "Навигатор доверяет")?.parentId, copiedFact.id);
  const links = await db.select().from(memoryLinks).where(eq(memoryLinks.fromId, copiedFact.id)); assert.equal(links.length, 1);
  const replayFork = await call<{ session: Session; replay: boolean }>(`/api/sessions/${source.id}/checkpoints/${pointId}/fork`, forkInput);
  assert.equal(replayFork.data.session.id, branch.session.id); assert.equal(replayFork.data.replay, true);
  assert.equal((await call(`/api/sessions/${source.id}/checkpoints/${pointId}/fork`, { ...forkInput, title: "Conflict" })).status, 409);
  assert.equal((await call(`/api/sessions/${branch.session.id}/checkpoints/${pointId}/fork`, { title: "Wrong owner", requestId: randomUUID() })).status, 404);
  const [storedPoint] = await db.select({ checksum: campaignCheckpoints.checksum }).from(campaignCheckpoints).where(eq(campaignCheckpoints.id, pointId));
  await db.update(campaignCheckpoints).set({ checksum: "damaged" }).where(eq(campaignCheckpoints.id, pointId));
  const damaged = await call(`/api/sessions/${source.id}/checkpoints/${pointId}/fork`, { title: "Must not be created", requestId: randomUUID() });
  assert.equal(damaged.status, 409); assert.equal(damaged.data.code, "SNAPSHOT_INTEGRITY");
  await db.update(campaignCheckpoints).set({ checksum: storedPoint.checksum }).where(eq(campaignCheckpoints.id, pointId));
  assert.equal((await call(`/api/sessions/${source.id}/checkpoints/${pointId}`, undefined, "DELETE")).status, 200);
  assert.equal((await call<Snapshot>(`/api/sessions/${branch.session.id}`)).status, 200);
  console.log("PASS: frozen checkpoints, request replay, independent fork identities and links, no future memory, snapshot deletion preserves branch");

  const choiceCampaign = await create("ashen-crown");
  const choiceSnapshot = (await call<Snapshot>(`/api/sessions/${choiceCampaign.id}`)).data;
  const choice = await call(`/api/sessions/${choiceCampaign.id}/act`, { action: choiceSnapshot.turns[0].choices![0], custom: false, expectedTurn: 1, requestId: randomUUID() });
  assert.equal(choice.status, 200); assert.ok(choice.data.dice, "a valid suggested d20 action uses server dice too");
  console.log("PASS: selecting a suggested action cannot bypass the campaign rules profile");

  const arena = await create("ashen-crown");
  let calls = 0; const gate = deferred(), entered = deferred();
  globalThis.fetch = async (input, init) => {
    if (!String(input).includes("generativelanguage.googleapis.com")) return nativeFetch(input, init);
    calls++; entered.resolve(); await gate.promise;
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ narration: "Незнакомец обещает встретиться с вами у старого моста после заката.", outcome: "neutral", choices: ["Изучить письмо", "Подойти к мосту", "Поговорить со свидетелем"], effects: {}, stateChanges: {} }) }] } }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 60 } });
  };
  const inputs = Array.from({ length: 6 }, (_, i) => ({ sessionId: arena.id, action: `Изучить улику ${i}`, isFree: true, expectedTurn: 1, requestId: randomUUID() }));
  const all = Promise.all(inputs.map((input) => performTurn(input, { loadAIConfig: async () => fakeConfig })));
  await Promise.race([entered.promise, new Promise((_, reject) => setTimeout(() => reject(new Error("Mock provider was not reached")), 10000))]);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const running = await db.select().from(turnRequests).where(and(eq(turnRequests.sessionId, arena.id), eq(turnRequests.status, "running"))); assert.equal(running.length, 1);
  assert.equal((await call(`/api/sessions/${arena.id}/checkpoints`, { title: "Busy", expectedTurn: 1, requestId: randomUUID() })).status, 429);
  assert.equal((await call(`/api/sessions/${arena.id}`, { status: "archived" }, "PATCH")).status, 429);
  assert.equal((await getTurnRequest(arena.id, running[0].requestId))?.status, "running");
  gate.resolve(); const results = await all;
  assert.equal(calls, 1, "only admitted action may invoke generation");
  const successIndex = results.findIndex((r) => r.ok); assert.ok(successIndex >= 0); assert.equal(results.filter((r) => r.ok).length, 1);
  const winning = results[successIndex]; assert.ok(winning.ok);
  const replay = await performTurn(inputs[successIndex], { loadAIConfig: async () => fakeConfig }); assert.ok(replay.ok); assert.equal(replay.replay, true); assert.equal(replay.outcome, winning.outcome); assert.deepEqual(replay.dice, winning.dice); assert.equal(calls, 1);
  const conflict = await performTurn({ ...inputs[successIndex], action: "Совсем другое действие" }); assert.ok(!conflict.ok); assert.equal(conflict.code, "IDEMPOTENCY_CONFLICT");
  const stale = await performTurn({ ...inputs[0], requestId: randomUUID() }); assert.ok(!stale.ok); assert.equal(stale.code, "STALE_TURN"); assert.equal(calls, 1);
  const forged = await call(`/api/sessions/${arena.id}/act`, { action: "Обойти бросок с произвольным действием", custom: false, expectedTurn: 2 }); assert.equal(forged.status, 400);
  const leasedInput = normalizeTurnInput({ sessionId: arena.id, action: "Проверить дверь", isFree: true, expectedTurn: 2, requestId: randomUUID() });
  const first = await acquireTurn(leasedInput); assert.equal(first.kind, "lease"); if (first.kind !== "lease") throw new Error("Expected lease");
  await db.update(turnRequests).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(turnRequests.id, first.lease.id));
  assert.equal((await getTurnRequest(arena.id, leasedInput.requestId))?.error, "LEASE_EXPIRED");
  const second = await acquireTurn(leasedInput); assert.equal(second.kind, "lease"); if (second.kind !== "lease") throw new Error("Expected lease");
  assert.notEqual(second.lease.token, first.lease.token); assert.deepEqual(second.lease.dice, first.lease.dice);
  await assert.rejects(db.transaction((tx) => assertTurnLease(tx, first.lease)));
  await failTurnRequest(second.lease, "TEST_CLEANUP");
  console.log("PASS: six contenders, one provider call, full response replay, payload binding, stale-scene rejection, dice reuse and lease fencing");

  calls = 0;
  globalThis.fetch = async (input, init) => {
    if (!String(input).includes("generativelanguage.googleapis.com")) return nativeFetch(input, init);
    calls++; await new Promise((resolve) => setTimeout(resolve, 40));
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ facts: [] }) }] } }] });
  };
  // Explicit readiness keeps fixtures independent of database session timezone.
  await db.update(memoryJobs).set({ nextAttemptAt: new Date(0) }).where(eq(memoryJobs.sessionId, arena.id));
  const extraction = await Promise.all([processSemanticJob({ sessionId: arena.id, cfg: fakeConfig }), processSemanticJob({ sessionId: arena.id, cfg: fakeConfig }), processSemanticJob({ sessionId: arena.id, cfg: fakeConfig })]);
  assert.equal(calls, 1); assert.equal(extraction.reduce((n, r) => n + r.processed, 0), 1);
  const [empty] = await db.select().from(memoryJobs).where(and(eq(memoryJobs.sessionId, arena.id), eq(memoryJobs.turnNumber, 2))); assert.equal(empty.status, "completed"); assert.equal(empty.factsCount, 0);
  await processSemanticJob({ sessionId: arena.id, cfg: fakeConfig }); assert.equal(calls, 1, "empty successful job must not run again");
  const phrase = "Навигатор обещает встретить героя у шлюза на рассвете.";
  await db.transaction((tx) => enqueueSemanticJob(tx, { sessionId: arena.id, turnNumber: 1, payload: { narration: phrase, playerAction: "Попросить о встрече", profileCanon: "Профиль d20.", knownDigest: "" } }));
  globalThis.fetch = async (input, init) => {
    if (!String(input).includes("generativelanguage.googleapis.com")) return nativeFetch(input, init);
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ facts: [{ type: "promise", entityKey: "test:promise", title: "Обещание навигатора", content: phrase, evidence: phrase, importance: 70, confidence: .9 }] }) }] } }] });
  };
  await db.update(memoryJobs).set({ nextAttemptAt: new Date(0) }).where(eq(memoryJobs.sessionId, arena.id));
  const populated = await processSemanticJob({ sessionId: arena.id, cfg: fakeConfig }); assert.equal(populated.extracted, 1);
  const [fact] = await db.select().from(memoryNodes).where(and(eq(memoryNodes.sessionId, arena.id), eq(memoryNodes.entityKey, "test:promise"))); assert.ok(fact);
  const [embedding] = await db.select().from(memoryEmbeddings).where(eq(memoryEmbeddings.memoryNodeId, fact.id)); assert.equal(embedding.status, "pending");
  const [done] = await db.select().from(memoryJobs).where(and(eq(memoryJobs.sessionId, arena.id), eq(memoryJobs.turnNumber, 1))); assert.equal(done.status, "completed"); assert.equal(done.factsCount, 1);
  // Reclaiming an abandoned memory job fences the old worker before fact writes.
  const pending = await db.transaction(async (tx) => { await enqueueSemanticJob(tx, { sessionId: branch.session.id, turnNumber: 1, payload: { narration: phrase, playerAction: "Слушать", profileCanon: "Narrative.", knownDigest: "" } }); return tx.select().from(memoryJobs).where(eq(memoryJobs.sessionId, branch.session.id)); });
  const lateGate = deferred(), lateEntered = deferred();
  globalThis.fetch = async () => { lateEntered.resolve(); await lateGate.promise; return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ facts: [{ type: "promise", entityKey: "test:late", title: "Поздний ответ", content: phrase, evidence: phrase, importance: 70, confidence: .9 }] }) }] } }] }); };
  await db.update(memoryJobs).set({ nextAttemptAt: new Date(0) }).where(eq(memoryJobs.sessionId, branch.session.id));
  const inflight = processSemanticJob({ sessionId: branch.session.id, cfg: fakeConfig }); await lateEntered.promise;
  await db.update(memoryJobs).set({ leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60000) }).where(eq(memoryJobs.id, pending[0].id));
  lateGate.resolve(); assert.equal((await inflight).processed, 0);
  assert.equal((await db.select().from(memoryNodes).where(and(eq(memoryNodes.sessionId, branch.session.id), eq(memoryNodes.entityKey, "test:late")))).length, 0);
  globalThis.fetch = nativeFetch;
  console.log("PASS: durable semantic queue, one worker per job, zero-fact completion, atomic fact/outbox writes, stale worker cannot write memory");

  const compactions = await Promise.all([compactSession(source.id), compactSession(source.id)]);
  assert.ok(compactions.some((r) => r.created > 0)); assert.ok(compactions.some((r) => r.mode === "already-applied" || r.mode === "up-to-date"));
  const sourceAfter = (await call<Snapshot>(`/api/sessions/${source.id}`)).data;
  assert.equal(sourceAfter.session.lastCompactTurn, sourceAfter.session.turnCount);
  assert.equal((await compactSession(source.id)).created, 0);
  const seq = sourceAfter.turns.filter((t) => t.turnNumber === 2).map((t) => t.role); assert.deepEqual(seq, ["player", "narrator"]);
  assert.equal((await runMemoryCycle({ source: "manual", sessionId: source.id, ownerId: smokeOwnerId })).paused, true);
  const status = await call<{ version: string; database: string }>("/api/system/status"); assert.equal(status.status, 200); assert.equal(status.data.version, "2.5"); assert.equal(status.data.database, "connected");
  assert.equal((await call("/api/system/process", { action: "process" })).status, 409);

  for (let round = 0; round < 3; round++) {
    const reads = Array.from({ length: 6 }, () => call<Snapshot>(`/api/sessions/${source.id}`));
    const writing = call(`/api/sessions/${source.id}/act`, { action: `Проверить архив: ${round}`, custom: true, requestId: randomUUID() });
    const snapshots = await Promise.all(reads); assert.equal((await writing).status, 200);
    for (const snapshot of snapshots) { assert.equal(snapshot.status, 200); assert.equal(Math.max(...snapshot.data.turns.filter((t) => t.role === "narrator").map((t) => t.turnNumber)), snapshot.data.session.turnCount); assert.ok(snapshot.data.memories.every((m) => (m.sourceTurn ?? 0) <= snapshot.data.session.turnCount)); }
  }
  console.log("PASS: consistent snapshots during turn writes, corrupt checkpoint rejected, empty index makes zero provider calls");
  console.log("PASS: whole-turn atomic compaction, repeat no-op, stable history order, offline queue status and honest disabled processing");
  console.log("ALL V2.2 INTEGRATION CHECKS PASSED");
}
run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  globalThis.fetch = nativeFetch;
  if (owned.length) { await db.delete(tokenLogs).where(inArray(tokenLogs.sessionId, owned)); await db.delete(gameSessions).where(inArray(gameSessions.id, owned)); }
  await cleanupSmokeIdentity();
  await pool.end();
});
