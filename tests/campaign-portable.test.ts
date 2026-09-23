import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { portableFixture as snapshot, source, now } from "./helpers/portable-fixture";

test("portable document round-trips representative engine state without runtime ownership", async () => {
  const { createPortableDocument, parsePortableDocument } = await import("../src/lib/campaign-portable");
  const original = snapshot(), document = createPortableDocument(original, now);
  const parsed = parsePortableDocument(JSON.parse(JSON.stringify(document)));
  assert.deepEqual(parsed.snapshot, original);
  assert.equal(document.format, "chronicle-campaign");
  assert.equal(document.schemaVersion, 1);
  assert.deepEqual(document.engine, { campaignMode: "free", rulesProfile: "rules-light" });
  assert.equal(parsed.snapshot.session.worldState.flags.marker, original.memories[0].id);
});

test("portable document retains d20 dice, applied changes, and verification evidence", async () => {
  const { createPortableDocument, parsePortableDocument } = await import("../src/lib/campaign-portable");
  const state = snapshot();
  state.session.rulesProfile = "d20";
  state.session.campaignMode = "preset";
  state.session.worldState.flags.chapter = 1;
  state.turns[0].dice = { goal: "Open gate", d20: 15, modifier: 2, total: 17, dc: 12,
    success: true, critical: null, skill: "Strength", label: "Gate", kind: "d20" };
  state.turns[0].stateChanges = {
    hp: 0, xp: 5, gold: 0, danger: 0, levelUp: false, dead: false,
    location: null, quests: [], npcs: [], inventory: [], sceneObjects: [],
    conditions: { added: [], removed: [] }, rejected: [],
  };
  state.turns[0].contextMeta = {
    model: "narrator", rulesProfile: "d20", digestChars: 15, retrievedIds: [state.memories[0].id],
    timings: { contextMs: 4, retrievalBackend: "postgres" }, retrievalMs: 4, skippedModels: [],
    narrativeVerification: {
      version: 1, reasons: ["state_change"], repaired: false, emittedCharacters: 17,
      checks: [{ status: "verified", provider: "typesafe", model: "jev-1.13.0", latencyMs: 3,
        answers: { accepted_state: { choice: "consistent", confidence: 0.9,
          probabilities: { consistent: 0.9, contradicts: 0.05, insufficient: 0.05 } } },
        usage: { inputTokens: 10, outputTokens: 4 } }],
      evidence: { completeHistory: false, truncated: false, sources: [] },
    },
  };
  const document = createPortableDocument(state, now);
  assert.deepEqual(parsePortableDocument(document).snapshot, state);
});

test("portable document accepts an archived source", async () => {
  const { createPortableDocument, parsePortableDocument } = await import("../src/lib/campaign-portable");
  const state = snapshot();
  state.session.status = "archived";
  const document = createPortableDocument(state, now);
  assert.equal(parsePortableDocument(document).snapshot.session.status, "archived");
});

test("portable import rejects malformed nested fields and unsafe controls before checksum traversal", async () => {
  const { createPortableDocument, parsePortableDocument } = await import("../src/lib/campaign-portable");
  const base = createPortableDocument(snapshot(), now);
  const changes: Array<(document: typeof base) => void> = [
    d => { (d.snapshot.session as unknown as Record<string, unknown>).ownerId = "attacker"; },
    d => { (d.snapshot.session as unknown as Record<string, unknown>).visibility = "public"; },
    d => { (d.snapshot.turns[0] as unknown as Record<string, unknown>).leaseToken = "attacker"; },
    d => { d.snapshot.session.character.stats.Wits = Number.POSITIVE_INFINITY; },
    d => { (d.snapshot.session.worldState.flags as Record<string, unknown>).paid = { unsafe: true }; },
    d => { d.snapshot.quests[0].status = "corrupt" as "active"; },
    d => { d.snapshot.inventory[0].createdAt = "not-a-date"; },
    d => { d.snapshot.inventory[0].quantity = -1; },
    d => { d.snapshot.session.worldState.danger = -1; },
    d => { d.snapshot.memories[0].importance = Number.NaN; },
    d => { d.snapshot.npcs[0].id = d.snapshot.inventory[0].id; },
    d => { d.snapshot.links.push({ id: d.snapshot.quests[0].id, fromId: d.snapshot.memories[0].id, toId: d.snapshot.memories[0].id, relation: "same" }); },
    d => { d.snapshot.inventory[0].sessionId = randomUUID(); },
    d => { d.snapshot.locations[0].connectedTo = [randomUUID()]; },
    d => { d.snapshot.memories[0].parentId = randomUUID(); },
    d => { d.snapshot.turns[0].contextMeta!.retrievedIds = [randomUUID()]; },
    d => { d.snapshot.session.character.skills = Array.from({ length: 10000 }, () => "x"); },
    d => { (d.snapshot.turns[0].contextMeta as unknown as Record<string, unknown>).narrativeVerification = { version: 1, checks: [{ status: "fake" }] }; },
  ];
  for (const change of changes) {
    const corrupt = structuredClone(base); change(corrupt);
    assert.throws(() => parsePortableDocument(corrupt), { name: "HttpError" });
  }
  const recursive = structuredClone(base) as unknown as Record<string, unknown>;
  recursive.self = recursive;
  assert.throws(() => parsePortableDocument(recursive), { name: "HttpError" });
});

test("portable checksum and agreement provenance reject changed claims", async () => {
  const { createPortableDocument, parsePortableDocument } = await import("../src/lib/campaign-portable");
  const base = createPortableDocument(snapshot(), now);
  base.snapshot.turns[0].content = "Changed";
  assert.throws(() => parsePortableDocument(base), { name: "HttpError", code: "SNAPSHOT_INTEGRITY" });
  const claimed = snapshot(), narrator = claimed.turns[0];
  claimed.agreements = [{
    id: randomUUID(), agreementId: randomUUID(), sessionId: source, turnNumber: 1, version: 1,
    previousRevisionId: null, parties: ["Ada", "merchant"], object: "key", consideration: "passage",
    conditions: [], status: "proposed", rulesVersion: 1,
    source: { kind: "current_turn", originTurnId: narrator.id, turnNumber: 1, quote: narrator.content,
      start: 0, end: narrator.content.length, textSha256: createHash("sha256").update(narrator.content).digest("hex") },
  }];
  const attested = createPortableDocument(claimed, now);
  attested.snapshot.agreements![0].source.quote = "Invented acceptance";
  const { snapshotChecksum } = await import("../src/lib/checkpoint-snapshot");
  attested.checksum = snapshotChecksum(attested.snapshot);
  assert.throws(() => parsePortableDocument(attested), { name: "HttpError", code: "SNAPSHOT_INTEGRITY" });
});

test("portable import rejects duplicate link IDs even when checksum is recalculated", async () => {
  const { createPortableDocument, parsePortableDocument } = await import("../src/lib/campaign-portable");
  const { snapshotChecksum } = await import("../src/lib/checkpoint-snapshot");
  const document = createPortableDocument(snapshot(), now);
  document.snapshot.links.push({ id: document.snapshot.inventory[0].id, fromId: document.snapshot.memories[0].id,
    toId: document.snapshot.memories[0].id, relation: "duplicate" });
  document.checksum = snapshotChecksum(document.snapshot);
  assert.throws(() => parsePortableDocument(document), { name: "HttpError", code: "INVALID_DOCUMENT" });
});

test("portable import rejects control fields hidden inside audit metadata", async () => {
  const { createPortableDocument, parsePortableDocument } = await import("../src/lib/campaign-portable");
  const { snapshotChecksum } = await import("../src/lib/checkpoint-snapshot");
  const document = createPortableDocument(snapshot(), now);
  (document.snapshot.turns[0].contextMeta as unknown as Record<string, unknown>).timings = { contextMs: 1, leaseCounter: 1 };
  document.checksum = snapshotChecksum(document.snapshot);
  assert.throws(() => parsePortableDocument(document), { name: "HttpError", code: "INVALID_DOCUMENT" });
});

test("portable import rejects out-of-range world and memory values with a matching checksum", async () => {
  const { createPortableDocument, parsePortableDocument } = await import("../src/lib/campaign-portable");
  const { snapshotChecksum } = await import("../src/lib/checkpoint-snapshot");
  for (const mutate of [
    (d: ReturnType<typeof createPortableDocument>) => { d.snapshot.session.worldState.danger = -1; },
    (d: ReturnType<typeof createPortableDocument>) => { d.snapshot.memories[0].importance = 200; },
  ]) {
    const document = createPortableDocument(snapshot(), now);
    mutate(document);
    document.checksum = snapshotChecksum(document.snapshot);
    assert.throws(() => parsePortableDocument(document), { name: "HttpError", code: "INVALID_DOCUMENT" });
  }
});

test("proxy raises the body cap only for the exact import POST path", async () => {
  const { NextRequest } = await import("next/server");
  const { proxy } = await import("../src/proxy");
  const headers = { origin: "https://game.test", "content-length": "70000" };
  const request = (path: string, overrides: Record<string, string> = {}) =>
    new NextRequest(`https://game.test${path}`, { method: "POST", headers: { ...headers, ...overrides } });
  assert.equal((await proxy(request("/api/sessions/import"))).status, 200);
  assert.equal((await proxy(request("/api/sessions/import/extra"))).status, 400);
  assert.equal((await proxy(request(`/api/sessions/${source}/copy`))).status, 413);
  assert.equal((await proxy(request("/api/sessions/import", { origin: "https://attacker.test" }))).status, 403);
  assert.equal((await proxy(request("/api/sessions/import", { "content-length": "5000000" }))).status, 413);
});
