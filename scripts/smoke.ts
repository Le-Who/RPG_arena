import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, pool } from "../src/db";
import { memoryEmbeddings, memoryNodes, tokenLogs } from "../src/db/schema";
import { SCENARIOS } from "../src/lib/scenarios";
import { backfillSession, indexPendingEmbeddings, searchMemory } from "../src/lib/embeddings";
import { upsertMemoryNode } from "../src/lib/memory";
import type { Session, Snapshot, Settings } from "../src/lib/ui-data";
const base = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ids: string[] = [];
const nativeFetch = globalThis.fetch;
async function call<T = Record<string, unknown>>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() as T };
}
async function run() {
  assert.equal((await call("/api/health")).status, 200);
  assert.equal((await call("/api/sessions/not-a-uuid")).status, 400);
  assert.equal((await call("/api/sessions", { mode: "wrong" })).status, 400);
  assert.equal((await call("/api/sessions", { mode: "free", customScenario: { title: 7 } })).status, 400);
  assert.equal((await call("/api/settings", { embeddingModel: "gemini-embedding-001" })).status, 400);
  const cfg = (await call<Settings>("/api/settings")).data;
  assert.ok(!cfg.useLiveAI, "Run smoke in an offline test workspace: it must not consume real generation quota.");
  for (const scenario of SCENARIOS) {
    const made = await call<{ session: Session }>("/api/sessions", { mode: "preset", scenarioId: scenario.id, characterIndex: 0 });
    assert.equal(made.status, 200, JSON.stringify(made.data));
    ids.push(made.data.session.id);
    const snapshot = (await call<Snapshot>(`/api/sessions/${made.data.session.id}`)).data;
    assert.equal(snapshot.turns.length, 1);
    assert.ok(snapshot.memories.length >= 3);
    assert.equal(snapshot.embeddings?.pending, snapshot.memories.length, "memory and durable outbox must commit together");
    assert.equal(snapshot.locations.filter((location) => location.current).length, 1);
    assert.equal(snapshot.locations.find((location) => location.current)?.name, snapshot.session.worldState.currentLocation);
    assert.equal(snapshot.session.rulesProfile, scenario.rulesProfile);
    assert.equal(snapshot.inventory.length, scenario.startInventory.length);
    if (scenario.rulesProfile !== "d20") assert.deepEqual(snapshot.session.character.stats, {});
  }
  console.log("PASS: all 8 authored worlds create atomically with canonical locations and durable outbox");
  const sessionId = ids[SCENARIOS.findIndex((s) => s.id === "ashen-crown")];
  const requests = Array.from({ length: 6 }, (_, i) => ({ action: `Изучить улику номер ${i}`, custom: true, requestId: randomUUID() }));
  const responses = await Promise.all(requests.map((body) => call(`/api/sessions/${sessionId}/act`, body)));
  const successes = responses.filter((r) => r.status === 200);
  assert.ok(successes.length >= 1);
  assert.ok(responses.every((r) => r.status === 200 || r.status === 429), JSON.stringify(responses));
  const after = (await call<Snapshot>(`/api/sessions/${sessionId}`)).data;
  assert.equal(after.session.turnCount, 1 + successes.length, "no lost updates");
  assert.equal(after.turns.filter((t) => t.role === "player").length, successes.length);
  assert.equal(new Set(after.turns.filter((t) => t.role === "narrator").map((t) => t.turnNumber)).size, successes.length + 1);
  const replayBody = requests[responses.findIndex((r) => r.status === 200)];
  const replay = await call(`/api/sessions/${sessionId}/act`, replayBody);
  assert.equal(replay.status, 200); assert.equal(replay.data.replay, true);
  assert.equal((await call<Snapshot>(`/api/sessions/${sessionId}`)).data.session.turnCount, after.session.turnCount);
  console.log(`PASS: 6 concurrent actions (${successes.length} accepted), unique turns, idempotent replay`);
  assert.equal((await call(`/api/sessions/${sessionId}`, { status: "archived", title: "Smoke archive" }, "PATCH")).status, 200);
  assert.equal((await call(`/api/sessions/${sessionId}/act`, { action: "Продолжить", custom: true })).status, 429);
  assert.equal((await call(`/api/sessions/${sessionId}`, { status: "active" }, "PATCH")).status, 200);
  const exportResponse = await fetch(`${base}/api/sessions/${sessionId}/export`);
  assert.equal(exportResponse.status, 200); assert.ok((await exportResponse.text()).includes("Smoke archive"));
  const free = await call<{ session: Session }>("/api/sessions", { mode: "free", rulesProfile: "narrative", customScenario: { title: "Smoke realistic drama", pitch: "Семейная встреча в современном городе.", tone: "реалистичная бытовая драма", startLocation: "Кухня" }, customCharacter: { name: "Ада", archetype: "Журналист" } });
  assert.equal(free.status, 200); ids.push(free.data.session.id);
  assert.equal((await call<Snapshot>(`/api/sessions/${free.data.session.id}`)).data.turns[0].choices?.length, 0);
  const unavailable = await call(`/api/sessions/${free.data.session.id}/act`, { action: "Поговорить с семьёй", custom: true });
  assert.equal(unavailable.status, 409); assert.equal(unavailable.data.code, "AI_REQUIRED");
  console.log("PASS: archive/restore, rename, export, free mode rejects fabricated offline narration");

  // Deterministic fake provider: verifies transport, leases, hashes and isolation; not semantic quality.
  let providerCalls = 0;
  const mockProvider: typeof fetch = async (input, init) => {
    if (!String(input).includes("generativelanguage.googleapis.com")) return nativeFetch(input, init);
    providerCalls++;
    const body = JSON.parse(String(init?.body)) as { requests?: { outputDimensionality: number }[]; outputDimensionality?: number };
    const requests = body.requests ?? [{ outputDimensionality: body.outputDimensionality! }];
    const embeddings = requests.map((r) => ({ values: Array.from({ length: r.outputDimensionality }, (_, i) => i === 0 ? 1 : 0) }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    return Response.json(body.requests ? { embeddings } : { embedding: embeddings[0] });
  };
  globalThis.fetch = mockProvider;
  const memorySession = ids[0];
  const opts = { sessionId: memorySession, keys: ["test-only-fake-provider"], model: "gemini-embedding-2", dims: 768 };
  await backfillSession(memorySession, opts.model, opts.dims);
  const batch = await Promise.all([indexPendingEmbeddings(opts), indexPendingEmbeddings(opts), indexPendingEmbeddings(opts)]);
  const memoryCount = (await db.select().from(memoryNodes).where(eq(memoryNodes.sessionId, memorySession))).length;
  assert.equal(batch.reduce((n, r) => n + r.indexed, 0), memoryCount); assert.equal(providerCalls, 1, "a leased batch must have one provider call");
  const canonical = await upsertMemoryNode({ sessionId: memorySession, layer: "semantic", category: "world", entityKey: "test:canonical", title: "Canonical test fact", content: "Это подтверждённая новая версия факта.", importance: 80, source: "state", sourceTurn: 4 });
  await upsertMemoryNode({ sessionId: memorySession, layer: "semantic", category: "world", entityKey: "test:canonical", title: "Untrusted replacement", content: "ИИ пытается заменить подтверждённый факт.", importance: 95, source: "ai-semantic", sourceTurn: 5 });
  const [kept] = await db.select().from(memoryNodes).where(eq(memoryNodes.id, canonical.id));
  assert.equal(kept.title, "Canonical test fact");
  let release!: () => void, announce!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { announce = resolve; });
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("generativelanguage.googleapis.com")) { announce(); await gate; }
    return mockProvider(input, init);
  };
  const inflight = indexPendingEmbeddings(opts);
  await entered;
  await upsertMemoryNode({ sessionId: memorySession, layer: "semantic", category: "world", entityKey: "test:canonical", title: "New canonical test fact", content: "Мир изменился, пока провайдер вычислял старый вектор.", importance: 80, source: "state", sourceTurn: 6 });
  release();
  assert.equal((await inflight).indexed, 0, "late provider result must fail compare-and-set");
  const [queued] = await db.select().from(memoryEmbeddings).where(eq(memoryEmbeddings.memoryNodeId, canonical.id));
  assert.equal(queued.status, "pending"); assert.equal(queued.vector, null); assert.equal(queued.leaseToken, null);
  globalThis.fetch = mockProvider;
  await indexPendingEmbeddings(opts);
  await indexPendingEmbeddings({ ...opts, sessionId: ids[1] });
  const found = await searchMemory({ ...opts, query: "Связанные факты", k: 20, minSimilarity: 0 });
  const ownedIds = new Set((await db.select({ id: memoryNodes.id }).from(memoryNodes).where(eq(memoryNodes.sessionId, memorySession))).map((n) => n.id));
  assert.ok(found.results.length > 0); assert.ok(found.results.every((n) => ownedIds.has(n.id)), "no cross-session retrieval");
  console.log("PASS: batch leases, provider shape, stale-result CAS, canonical precedence, cross-session isolation");
}
run().then(() => console.log("ALL INTEGRATION CHECKS PASSED")).catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  globalThis.fetch = nativeFetch;
  if (ids.length) await db.delete(tokenLogs).where(inArray(tokenLogs.sessionId, ids));
  for (const id of ids) await nativeFetch(`${base}/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
  await pool.end();
});
