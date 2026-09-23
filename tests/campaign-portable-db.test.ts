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

async function portableDb() {
  const { pool } = await import("../src/db");
  const pg = new PGlite({ extensions: { vector, pgcrypto } });
  await pg.exec("SET TIME ZONE 'UTC'");
  for (const file of (await readdir("drizzle")).filter(x => /^\d{4}_.*\.sql$/.test(x)).sort()) await pg.exec(await readFile(`drizzle/${file}`, "utf8"));
  const run = async (query: string | { text: string; values?: unknown[]; rowMode?: string }, values?: unknown[]) => {
    const config = typeof query === "string" ? { text: query, values } : { ...query, values: values ?? query.values };
    if (config.text.startsWith("BEGIN;")) { await pg.exec(config.text); return { rows: [] }; }
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
    const verifiedProse = `Ada carries ${item} to the market.`;
    const verifiedMeta = {
      model: "narrator", rulesProfile: "d20", digestChars: 0, retrievedIds: [],
      narrativeVerification: {
        version: 1, reasons: ["state_change"], repaired: false, emittedCharacters: verifiedProse.length,
        textSha256: createHash("sha256").update(verifiedProse).digest("hex"),
        checks: [{ status: "verified", provider: "typesafe", model: "jev-1.13.0", latencyMs: 1, answers: {} }],
        evidence: { completeHistory: false, truncated: false, sources: [] },
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
    const imported = await cookieContext(`chronicle_guest=${otherToken}`, () => POST(request()));
    assert.equal(imported.status, 201);
    const result = await imported.json();
    assert.equal(result.replay, false);
    assert.equal(result.session.title, "My Harbor");
    assert.equal(result.session.ownerId, other);
    assert.equal(result.session.visibility, "private");
    assert.equal(result.session.status, "active");
    assert.notEqual(result.session.id, source);
    const replay = await cookieContext(`chronicle_guest=${otherToken}`, () => POST(request()));
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).session.id, result.session.id);
    const conflict = await cookieContext(`chronicle_guest=${otherToken}`, () => POST(new Request("https://game.test/api/sessions/import", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "portable-retry", document, title: "Other Harbor" }),
    })));
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, "IDEMPOTENCY_CONFLICT");
    const copiedItem = (await fixture.pg.query<{ id: string }>("SELECT id FROM inventory_items WHERE session_id=$1", [result.session.id])).rows[0];
    const copiedMemory = (await fixture.pg.query<{ entity_key: string }>("SELECT entity_key FROM memory_nodes WHERE session_id=$1", [result.session.id])).rows[0];
    const copiedTurn = (await fixture.pg.query<{ id: string; request_id: string | null }>("SELECT id,request_id FROM game_turns WHERE session_id=$1 AND turn_number=1", [result.session.id])).rows[0];
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
    const invalidDocument = structuredClone(document);
    invalidDocument.snapshot.turns.find((turn: { turnNumber: number }) => turn.turnNumber === 2).contextMeta.narrativeVerification.textSha256 = "0".repeat(64);
    const { snapshotChecksum } = await import("../src/lib/checkpoint-snapshot");
    invalidDocument.checksum = snapshotChecksum(invalidDocument.snapshot);
    const invalidResponse = await cookieContext(`chronicle_guest=${otherToken}`, () => POST(new Request("https://game.test/api/sessions/import", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "invalid-verification", document: invalidDocument, title: "Invalid verification" }),
    })));
    assert.equal(invalidResponse.status, 201);
    const invalidCampaign = (await invalidResponse.json()).session.id;
    const copiedInvalid = (await fixture.pg.query<{ id: string; content: string; context_meta: typeof verifiedMeta }>("SELECT id,content,context_meta FROM game_turns WHERE session_id=$1 AND turn_number=2", [invalidCampaign])).rows[0];
    assert.equal(copiedInvalid.context_meta.narrativeVerification.textSha256, undefined);
    assert.equal(snapshotNarrativeEvidence([{ id: copiedInvalid.id, turn_number: 2, role: "narrator", content: copiedInvalid.content,
      state_changes: null, verification: copiedInvalid.context_meta.narrativeVerification }]).sources[0].authority, "legacy_narration");
    assert.equal(Number((await fixture.pg.query<{ n: number }>("SELECT count(*)::int n FROM memory_jobs WHERE session_id=$1", [result.session.id])).rows[0].n), 0);
    assert.equal((await fixture.pg.query<{ status: string; dims: number }>("SELECT status,dims FROM memory_embeddings WHERE session_id=$1", [result.session.id])).rows[0].status, "pending");
    await fixture.pg.query("DELETE FROM game_sessions WHERE id=$1", [result.session.id]);
    await fixture.pg.query("DELETE FROM game_sessions WHERE id=$1", [invalidCampaign]);
    const deleted = await cookieContext(`chronicle_guest=${otherToken}`, () => POST(request()));
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
