import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { cookieContext } from "./helpers/accounts-db";
import { portableFixture } from "./helpers/portable-fixture";
import { newGuestToken, profileIdFromToken } from "../src/lib/guest-identity";

async function portableDb({ importLockAvailable = true } = {}) {
  const { pool } = await import("../src/db");
  const pg = new PGlite({ extensions: { vector, pgcrypto } });
  await pg.exec("SET TIME ZONE 'UTC'");
  for (const file of (await readdir("drizzle")).filter(x => /^\d{4}_.*\.sql$/.test(x)).sort()) await pg.exec(await readFile(`drizzle/${file}`, "utf8"));
  const run = async (query: string | { text: string; values?: unknown[]; rowMode?: string }, values?: unknown[]) => {
    const config = typeof query === "string" ? { text: query, values } : { ...query, values: values ?? query.values };
    if (config.text.startsWith("BEGIN;")) { await pg.exec(config.text); return { rows: [] }; }
    // PGlite owns one connection, so model a lock held by another PostgreSQL connection.
    if (!importLockAvailable && config.text.includes("hashtext('campaign-import')")) return { rows: [{ locked: false }] };
    const result = await pg.query<Record<string, unknown>>(config.text, config.values);
    return { ...result, rows: result.rows.map(row => config.rowMode === "array" ? result.fields.map(f => row[f.name]) : row) };
  };
  const queryMock = mock.method(pool, "query", run as never);
  const connectMock = mock.method(pool, "connect", async () => ({ query: run, release() {} }) as never);
  return { pg, async close() { queryMock.mock.restore(); connectMock.mock.restore(); await pg.close(); } };
}

test("portable HTTP export is owner-only and import remaps structured data without copying jobs or credentials", async () => {
  const fixture = await portableDb();
  try {
    const ownerToken = newGuestToken(), otherToken = newGuestToken();
    const owner = profileIdFromToken(ownerToken)!, other = profileIdFromToken(otherToken)!;
    const source = randomUUID(), memory = randomUUID(), location = randomUUID(), item = randomUUID();
    const world = { worldName: "Harbor", tone: "Hopeful", era: "Age of sail", mainQuest: "Trade", currentLocation: "Market", factions: ["Guild"], flags: { marker: item }, danger: 5, chapter: 1 };
    const character = { name: "Ada", archetype: "Trader", level: 1, xp: 0, hp: 10, maxHp: 10, gold: 5, stats: {}, skills: [], traits: [], backstory: "", appearance: "" };
    await fixture.pg.query("INSERT INTO game_sessions(id,owner_id,visibility,title,character,world_state,turn_count) VALUES ($1,$2,'public','Harbor',$3,$4,2)", [source, owner, JSON.stringify(character), JSON.stringify(world)]);
    await fixture.pg.query("INSERT INTO game_turns(session_id,turn_number,role,content,request_id) VALUES ($1,1,'narrator','Market opens','old-request')", [source]);
    const origin = (await fixture.pg.query<{ id: string }>("SELECT id FROM game_turns WHERE session_id=$1", [source])).rows[0].id;
    const agreementId = randomUUID(), revisionId = randomUUID(), quote = "Market opens";
    await fixture.pg.query(
      "INSERT INTO agreement_events(id,agreement_id,session_id,turn_number,version,previous_revision_id,parties,object,consideration,conditions,status,rules_version,source) VALUES ($1,$2,$3,1,1,null,$4,'key','passage',$5,'proposed',1,$6)",
      [revisionId, agreementId, source, JSON.stringify(["Ada", "merchant"]), JSON.stringify([]),
        JSON.stringify({ kind: "current_turn", originTurnId: origin, turnNumber: 1, quote, start: 0, end: quote.length,
          textSha256: createHash("sha256").update(quote).digest("hex") })],
    );
    await fixture.pg.query("INSERT INTO world_locations(id,session_id,name,current,connected_to) VALUES ($1,$2,'Market',true,$3)", [location, source, JSON.stringify([location])]);
    await fixture.pg.query("INSERT INTO inventory_items(id,session_id,name) VALUES ($1,$2,'Key')", [item, source]);
    const historicalProse = `Ada found ${item}.`;
    await fixture.pg.query("INSERT INTO game_turns(session_id,turn_number,role,content) VALUES ($1,1,'player',$2)", [source, historicalProse]);
    const historicalId = (await fixture.pg.query<{ id: string }>("SELECT id FROM game_turns WHERE session_id=$1 AND turn_number=1 AND role='player'", [source])).rows[0].id;
    const historicalHash = createHash("sha256").update(historicalProse).digest("hex");
    const verifiedProse = `Ada carries ${item} to the market.`;
    const verifiedMeta = {
      model: "narrator", rulesProfile: "d20", digestChars: 0, retrievedIds: [],
      narrativeVerification: {
        version: 1, reasons: ["state_change"], repaired: false, emittedCharacters: verifiedProse.length,
        textSha256: createHash("sha256").update(verifiedProse).digest("hex"),
        checks: [{ status: "verified", provider: "typesafe", model: "jev-1.13.0", latencyMs: 1, answers: {} }],
        reviews: [{ attempt: 0, model: "reviewer", latencyMs: 1, result: {
          status: "verified", answers: [{ id: "history_1", verdict: "consistent", reason: "Historical source",
            evidence: [{ path: "/historical_evidence/sources/0/text", quote: historicalProse }] }],
        } }],
        evidence: { completeHistory: false, truncated: false, sources: [
          { id: historicalId, turn: 1, role: "player", text: historicalProse, sha256: historicalHash,
            truncated: false, authority: "intention", acceptedChanges: null },
        ] },
      },
    };
    await fixture.pg.query("INSERT INTO game_turns(session_id,turn_number,role,content,context_meta) VALUES ($1,2,'narrator',$2,$3)", [source, verifiedProse, JSON.stringify(verifiedMeta)]);
    await fixture.pg.query("INSERT INTO memory_nodes(id,session_id,layer,category,title,content,parent_id,entity_key) VALUES ($1,$2,'semantic','world','Market','A market',null,$3)", [memory, source, `item:${item}`]);
    await fixture.pg.query("INSERT INTO memory_jobs(session_id,turn_number,payload) VALUES ($1,1,'{}')", [source]);
    await fixture.pg.query("INSERT INTO ai_settings(id,keys,embedding_dims) VALUES ($1,$2,1536)", [other, JSON.stringify(["secret"])]);
    const { GET } = await import("../src/app/api/sessions/[id]/export/route");
    const ctx = { params: Promise.resolve({ id: source }) };
    const denied = await cookieContext(`chronicle_guest=${otherToken}`, () => GET(new Request(`https://game.test/api/sessions/${source}/export?format=json`), ctx));
    assert.equal(denied.status, 404);
    const markdown = await cookieContext(`chronicle_guest=${otherToken}`, () => GET(new Request(`https://game.test/api/sessions/${source}/export`), ctx));
    assert.equal(markdown.status, 200);
    assert.match(markdown.headers.get("content-type")!, /markdown/);
    const exported = await cookieContext(`chronicle_guest=${ownerToken}`, () => GET(new Request(`https://game.test/api/sessions/${source}/export?format=json`), ctx));
    assert.equal(exported.status, 200, await exported.clone().text());
    const document = await exported.json();
    const { snapshotNarrativeEvidence } = await import("../src/lib/narrative-evidence");
    const sourceVerified = document.snapshot.turns.find((turn: { turnNumber: number }) => turn.turnNumber === 2);
    assert.equal(snapshotNarrativeEvidence([{ id: sourceVerified.id, turn_number: 2, role: "narrator", content: sourceVerified.content,
      state_changes: null, verification: sourceVerified.contextMeta.narrativeVerification }]).sources[0].authority, "verified_narration");
    assert.equal(document.snapshot.turns[0].requestId, null);
    assert.equal(document.snapshot.agreements.length, 1);
    assert.equal(document.snapshot.session.ownerId, undefined);
    assert.equal(document.snapshot.session.visibility, undefined);
    assert.ok(!JSON.stringify(document).includes("secret"));
    const { POST } = await import("../src/app/api/sessions/import/route");
    const body = JSON.stringify({ requestId: "portable-retry", document, title: "My Harbor" });
    const request = () => new Request("https://game.test/api/sessions/import", { method: "POST", headers: { "content-type": "application/json" }, body });
    const guestDenied = await cookieContext(`chronicle_guest=${otherToken}`, () => POST(request()));
    assert.equal(guestDenied.status, 403);
    assert.equal((await guestDenied.json()).code, "ACCOUNT_REQUIRED");
    const { auth } = await import("../src/lib/auth");
    const registered = await auth.register(otherToken, "portable-user", "correct horse battery staple");
    const accountCookie = `chronicle_guest=${registered.guestToken}; chronicle_session=${registered.sessionToken}`;
    const imported = await cookieContext(accountCookie, () => POST(request()));
    assert.equal(imported.status, 201);
    const result = await imported.json();
    assert.equal(result.replay, false);
    assert.equal(result.session.title, "My Harbor");
    assert.equal(result.session.ownerId, other);
    assert.equal(result.session.visibility, "private");
    assert.equal(result.session.status, "active");
    assert.notEqual(result.session.id, source);
    const replay = await cookieContext(accountCookie, () => POST(request()));
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).session.id, result.session.id);
    const conflict = await cookieContext(accountCookie, () => POST(new Request("https://game.test/api/sessions/import", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "portable-retry", document, title: "Other Harbor" }),
    })));
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, "IDEMPOTENCY_CONFLICT");
    const copiedItem = (await fixture.pg.query<{ id: string }>("SELECT id FROM inventory_items WHERE session_id=$1", [result.session.id])).rows[0];
    const copiedMemory = (await fixture.pg.query<{ entity_key: string }>("SELECT entity_key FROM memory_nodes WHERE session_id=$1", [result.session.id])).rows[0];
    const copiedTurn = (await fixture.pg.query<{ id: string; request_id: string | null }>("SELECT id,request_id FROM game_turns WHERE session_id=$1 AND turn_number=1 AND role='narrator'", [result.session.id])).rows[0];
    const copiedHistorical = (await fixture.pg.query<{ id: string }>("SELECT id FROM game_turns WHERE session_id=$1 AND turn_number=1 AND role='player'", [result.session.id])).rows[0];
    const copiedVerified = (await fixture.pg.query<{ id: string; content: string; context_meta: typeof verifiedMeta }>("SELECT id,content,context_meta FROM game_turns WHERE session_id=$1 AND turn_number=2", [result.session.id])).rows[0];
    const revision = (await fixture.pg.query<{ id: string; agreement_id: string; source: { originTurnId: string; quote: string } }>("SELECT id,agreement_id,source FROM agreement_events WHERE session_id=$1", [result.session.id])).rows[0];
    assert.notEqual(copiedItem.id, item);
    assert.equal(copiedMemory.entity_key, `item:${copiedItem.id}`);
    const copiedLocation = (await fixture.pg.query<{ id: string; connected_to: string[] }>("SELECT id,connected_to FROM world_locations WHERE session_id=$1", [result.session.id])).rows[0];
    assert.deepEqual(copiedLocation.connected_to, [copiedLocation.id]);
    assert.equal(copiedTurn.request_id, null);
    assert.notEqual(revision.id, revisionId);
    assert.notEqual(revision.agreement_id, agreementId);
    assert.equal(revision.source.originTurnId, copiedTurn.id);
    assert.equal(revision.source.quote, quote);
    assert.ok(copiedVerified.content.includes(copiedItem.id));
    assert.ok(!copiedVerified.content.includes(item));
    assert.equal(snapshotNarrativeEvidence([{ id: copiedVerified.id, turn_number: 2, role: "narrator", content: copiedVerified.content,
      state_changes: null, verification: copiedVerified.context_meta.narrativeVerification }]).sources[0].authority, "verified_narration");
    const copiedAudit = copiedVerified.context_meta.narrativeVerification;
    const copiedSource = copiedAudit.evidence.sources[0];
    assert.equal(copiedSource.id, copiedHistorical.id);
    assert.notEqual(copiedSource.id, historicalId);
    assert.equal(copiedSource.text, historicalProse);
    assert.equal(copiedSource.sha256, historicalHash);
    assert.equal(createHash("sha256").update(copiedSource.text).digest("hex"), copiedSource.sha256);
    const copiedCitation = copiedAudit.reviews[0].result.answers[0].evidence[0];
    assert.equal(copiedCitation.quote, historicalProse);
    const { matchesNarrativeCitation } = await import("../src/lib/narrative-review");
    assert.equal(matchesNarrativeCitation({ historical_evidence: copiedAudit.evidence }, copiedCitation.path, copiedCitation.quote), true);
    const invalidDocument = structuredClone(document);
    invalidDocument.snapshot.turns.find((turn: { turnNumber: number }) => turn.turnNumber === 2).contextMeta.narrativeVerification.textSha256 = "0".repeat(64);
    invalidDocument.snapshot.turns.find((turn: { turnNumber: number }) => turn.turnNumber === 2).contextMeta.narrativeVerification.evidence.sources[0].sha256 = "0".repeat(64);
    const { snapshotChecksum } = await import("../src/lib/checkpoint-snapshot");
    invalidDocument.checksum = snapshotChecksum(invalidDocument.snapshot);
    const invalidResponse = await cookieContext(accountCookie, () => POST(new Request("https://game.test/api/sessions/import", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "invalid-verification", document: invalidDocument, title: "Invalid verification" }),
    })));
    assert.equal(invalidResponse.status, 201);
    const invalidCampaign = (await invalidResponse.json()).session.id;
    const copiedInvalid = (await fixture.pg.query<{ id: string; content: string; context_meta: typeof verifiedMeta }>("SELECT id,content,context_meta FROM game_turns WHERE session_id=$1 AND turn_number=2", [invalidCampaign])).rows[0];
    assert.equal(copiedInvalid.context_meta.narrativeVerification.textSha256, undefined);
    assert.equal(copiedInvalid.context_meta.narrativeVerification.evidence.sources[0].sha256, "0".repeat(64));
    assert.notEqual(createHash("sha256").update(copiedInvalid.context_meta.narrativeVerification.evidence.sources[0].text).digest("hex"),
      copiedInvalid.context_meta.narrativeVerification.evidence.sources[0].sha256);
    assert.equal(snapshotNarrativeEvidence([{ id: copiedInvalid.id, turn_number: 2, role: "narrator", content: copiedInvalid.content,
      state_changes: null, verification: copiedInvalid.context_meta.narrativeVerification }]).sources[0].authority, "legacy_narration");
    assert.equal(Number((await fixture.pg.query<{ n: number }>("SELECT count(*)::int n FROM memory_jobs WHERE session_id=$1", [result.session.id])).rows[0].n), 0);
    assert.equal((await fixture.pg.query<{ status: string; dims: number }>("SELECT status,dims FROM memory_embeddings WHERE session_id=$1", [result.session.id])).rows[0].status, "pending");
    await fixture.pg.query("DELETE FROM game_sessions WHERE id=$1", [result.session.id]);
    await fixture.pg.query("DELETE FROM game_sessions WHERE id=$1", [invalidCampaign]);
    const deleted = await cookieContext(accountCookie, () => POST(request()));
    assert.equal(deleted.status, 410);
    assert.equal((await deleted.json()).code, "IMPORT_DELETED");
    assert.equal(Number((await fixture.pg.query<{ n: number }>("SELECT count(*)::int n FROM game_sessions WHERE owner_id=$1", [other])).rows[0].n), 0);
  } finally { await fixture.close(); }
});

test("portable failed import leaves neither target nor ledger", async () => {
  const fixture = await portableDb();
  try {
    const { createPortableDocument } = await import("../src/lib/campaign-portable");
    const { importCampaign } = await import("../src/lib/campaign-copy");
    const document = createPortableDocument(portableFixture());
    // A valid document with a duplicate relational key passes document integrity but fails SQL.
    document.snapshot.quests.push({ ...document.snapshot.quests[0], id: randomUUID() });
    const { snapshotChecksum } = await import("../src/lib/checkpoint-snapshot");
    document.checksum = snapshotChecksum(document.snapshot);
    await assert.rejects(() => importCampaign({ profileId: "owner", requestId: "rollback", document }), error => /duplicate|unique/i.test(String((error as Error & { cause?: Error }).cause)));
    assert.equal(Number((await fixture.pg.query<{ n: number }>("SELECT count(*)::int n FROM game_sessions")).rows[0].n), 0);
    assert.equal(Number((await fixture.pg.query<{ n: number }>("SELECT count(*)::int n FROM campaign_imports")).rows[0].n), 0);
  } finally { await fixture.close(); }
});

test("portable import enforces the profile admission quota before materializing a campaign", async () => {
  const fixture = await portableDb();
  try {
    const owner = "account-import-quota";
    for (let i = 0; i < 20; i++) {
      await fixture.pg.query("INSERT INTO campaign_imports(owner_id,request_id,input_hash) VALUES ($1,$2,$3)", [owner, `prior-${i}`, `hash-${i}`]);
    }
    const { createPortableDocument } = await import("../src/lib/campaign-portable");
    const { importCampaign } = await import("../src/lib/campaign-copy");
    await assert.rejects(
      () => importCampaign({ profileId: owner, requestId: "over-daily-limit", document: createPortableDocument(portableFixture()) }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "IMPORT_RATE_LIMIT",
    );
    assert.equal(Number((await fixture.pg.query<{ n: number }>("SELECT count(*)::int n FROM game_sessions WHERE owner_id=$1", [owner])).rows[0].n), 0);
  } finally { await fixture.close(); }
});

test("portable HTTP import reports a busy profile before creating any campaign rows", async () => {
  const fixture = await portableDb({ importLockAvailable: false });
  try {
    const { auth } = await import("../src/lib/auth");
    const account = await auth.register(newGuestToken(), "busy-importer", "correct horse battery staple");
    const { createPortableDocument } = await import("../src/lib/campaign-portable");
    const { POST } = await import("../src/app/api/sessions/import/route");
    const response = await cookieContext(`chronicle_guest=${account.guestToken}; chronicle_session=${account.sessionToken}`, () => POST(new Request("https://game.test/api/sessions/import", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "busy-attempt", document: createPortableDocument(portableFixture()) }),
    })));
    assert.equal(response.status, 409);
    assert.equal(response.headers.get("Retry-After"), "1");
    assert.equal((await response.json()).code, "IMPORT_BUSY");
    for (const table of ["game_sessions", "campaign_imports", "owner_activity"]) {
      assert.equal(Number((await fixture.pg.query<{ n: number }>(`SELECT count(*)::int n FROM ${table}`)).rows[0].n), 0);
    }
  } finally { await fixture.close(); }
});

test("portable deleted-import tombstones survive later imports regardless of age", async () => {
  const fixture = await portableDb();
  try {
    const { createPortableDocument } = await import("../src/lib/campaign-portable");
    const { importCampaign } = await import("../src/lib/campaign-copy");
    const document = createPortableDocument(portableFixture());
    const original = { profileId: "account-old-import", requestId: "old-attempt", document };
    const imported = await importCampaign(original);
    await fixture.pg.query("UPDATE campaign_imports SET created_at=now()-interval '31 days' WHERE owner_id=$1", [original.profileId]);
    await fixture.pg.query("DELETE FROM game_sessions WHERE id=$1", [imported.session.id]);
    await importCampaign({ ...original, requestId: "fresh-attempt" });
    await assert.rejects(() => importCampaign(original), error => (error as { code?: string }).code === "IMPORT_DELETED");
    await assert.rejects(() => importCampaign({ ...original, title: "Different document title" }), error => (error as { code?: string }).code === "IDEMPOTENCY_CONFLICT");
    const rows = await fixture.pg.query<{ n: number }>("SELECT count(*)::int n FROM campaign_imports WHERE owner_id=$1", [original.profileId]);
    assert.equal(rows.rows[0].n, 2);
    assert.equal(Number((await fixture.pg.query<{ n: number }>("SELECT count(*)::int n FROM game_sessions WHERE owner_id=$1", [original.profileId])).rows[0].n), 1);
  } finally { await fixture.close(); }
});

test("portable import quotas preserve replay and remain isolated to their owner", async t => {
  const fixture = await portableDb();
  try {
    const { createPortableDocument } = await import("../src/lib/campaign-portable");
    const { importCampaign } = await import("../src/lib/campaign-copy");
    const document = createPortableDocument(portableFixture());
    for (const { kind, limit, code } of [
      { kind: "active", limit: 10, code: "IMPORT_STORAGE_QUOTA" },
      { kind: "daily", limit: 20, code: "IMPORT_RATE_LIMIT" },
      { kind: "history", limit: 1000, code: "IMPORT_HISTORY_QUOTA" },
    ]) await t.test(kind, async () => {
      const original = { profileId: `account-${kind}-quota`, requestId: "saved-attempt", document };
      const imported = await importCampaign(original);
      if (kind === "active") {
        for (let i = 1; i < limit; i++) await importCampaign({ ...original, requestId: `prior-${i}` });
      } else {
        await fixture.pg.query(
          `INSERT INTO campaign_imports(owner_id,request_id,input_hash,created_at)
           SELECT $1,'prior-' || n,'previous-hash',CASE WHEN $3 THEN now()-interval '31 days' ELSE now() END
           FROM generate_series(1,$2::int) n`,
          [original.profileId, limit - 1, kind === "history"],
        );
      }
      await assert.rejects(() => importCampaign({ ...original, requestId: "over-limit" }), error => (error as { code?: string }).code === code);
      const replay = await importCampaign(original);
      assert.equal(replay.replay, true);
      assert.equal(replay.session.id, imported.session.id);
      await assert.rejects(() => importCampaign({ ...original, title: "Changed title" }), error => (error as { code?: string }).code === "IDEMPOTENCY_CONFLICT");
      assert.equal(Number((await fixture.pg.query<{ n: number }>("SELECT count(*)::int n FROM campaign_imports WHERE owner_id=$1", [original.profileId])).rows[0].n), limit);
      assert.equal(Number((await fixture.pg.query<{ n: number }>("SELECT count(*)::int n FROM game_sessions WHERE owner_id=$1", [original.profileId])).rows[0].n), kind === "active" ? 10 : 1);
      assert.equal((await importCampaign({ ...original, profileId: `unrelated-${kind}` })).replay, false);
      await fixture.pg.query("DELETE FROM game_sessions WHERE id=$1", [imported.session.id]);
      await assert.rejects(() => importCampaign(original), error => (error as { code?: string }).code === "IMPORT_DELETED");
      if (kind === "active") assert.equal((await importCampaign({ ...original, requestId: "replacement" })).replay, false);
      else await assert.rejects(() => importCampaign({ ...original, requestId: "after-delete" }), error => (error as { code?: string }).code === code);
    });
  } finally { await fixture.close(); }
});
