// Explicit opt-in: only the controller-owned local PG test database, never .env.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";

test("twelve independent PostgreSQL imports serialize to one campaign and preserve tombstones", {
  skip: process.env.CHRONICLE_RUN_PORTABLE_POSTGRES !== "1", timeout: 60000,
}, async () => {
  const schema = `portable_task4_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, /^portable_task4_[0-9a-f]{32}$/);
  const url = new URL("postgresql://chronicle_test@127.0.0.1:55439/chronicle_auth_test");
  const bootstrap = new Pool({ connectionString: url.toString() });
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  url.searchParams.set("options", `-csearch_path=${schema},public`);
  process.env.DATABASE_URL = url.toString();
  const { pool } = await import("../../src/db");
  try {
    for (const file of (await readdir("drizzle")).filter(x => /^\d{4}_.*\.sql$/.test(x) && !x.startsWith("0006_")).sort())
      await pool.query((await readFile(`drizzle/${file}`, "utf8")).replaceAll('"public".', `"${schema}".`));
    const source = randomUUID(), location = randomUUID(), owner = "test-owner", importer = "test-importer";
    const world = { worldName: "Harbor", tone: "Hopeful", era: "Sail", mainQuest: "Trade", currentLocation: "Market", factions: [], flags: {}, danger: 5, chapter: 1 };
    const character = { name: "Ada", archetype: "Trader", level: 1, xp: 0, hp: 10, maxHp: 10, gold: 5, stats: {}, skills: [], traits: [], backstory: "", appearance: "" };
    await pool.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state,turn_count) VALUES ($1,$2,'Harbor',$3,$4,1)", [source, owner, character, world]);
    await pool.query("INSERT INTO game_turns(session_id,turn_number,role,content) VALUES ($1,1,'narrator','Market opens')", [source]);
    await pool.query("INSERT INTO world_locations(id,session_id,name,current) VALUES ($1,$2,'Market',true)", [location, source]);
    const { exportPortableCampaign } = await import("../../src/lib/campaign-export");
    const { importCampaign, copyCampaign } = await import("../../src/lib/campaign-copy");
    const { snapshotChecksum } = await import("../../src/lib/checkpoint-snapshot");
    await pool.query("UPDATE game_sessions SET visibility='public' WHERE id=$1", [source]);
    const gatePool = new Pool({ connectionString: url.toString() });
    const gate = await gatePool.connect();
    try {
      await gate.query("BEGIN");
      await gate.query("SELECT pg_advisory_xact_lock(hashtext($1))", [source]);
      await gate.query("UPDATE game_sessions SET visibility='private' WHERE id=$1", [source]);
      const pending = copyCampaign({ sessionId: source, profileId: "reader", requestId: "unpublish-race" });
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const waiting = await gatePool.query<{ n: number }>("SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND NOT granted");
        if (waiting.rows[0].n > 0) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true, "copy reached the campaign lock before unpublish commits");
      await gate.query("COMMIT");
      await assert.rejects(pending, error => (error as { code?: string }).code === "NOT_FOUND");
      assert.equal(Number((await pool.query("SELECT count(*)::int n FROM game_sessions WHERE owner_id='reader'")).rows[0].n), 0);
    } finally {
      await gate.query("ROLLBACK").catch(() => undefined);
      gate.release();
      await gatePool.end();
    }
    let entered!: () => void, release!: () => void;
    const firstRead = new Promise<void>(resolve => { entered = resolve; });
    const proceed = new Promise<void>(resolve => { release = resolve; });
    const originalConnect = pool.connect.bind(pool);
    let paused = false;
    const connectMock = mock.method(pool, "connect", async () => {
      const client = await originalConnect();
      const originalQuery = client.query.bind(client);
      client.query = (async (...args: unknown[]) => {
        const result = await (originalQuery as (...args: unknown[]) => Promise<unknown>)(...args);
        const text = typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text;
        if (!paused && /from "game_sessions"/i.test(text) && /owner_id/i.test(text)) {
          paused = true; entered(); await proceed;
        }
        return result;
      }) as typeof client.query;
      return client;
    });
    const writer = new Pool({ connectionString: url.toString() });
    try {
      const concurrentExport = exportPortableCampaign(source, owner);
      await firstRead;
      const writerClient = await writer.connect();
      try {
        await writerClient.query("BEGIN");
        await writerClient.query("UPDATE game_sessions SET world_state=jsonb_set(world_state,'{currentLocation}','\"Dock\"'), turn_count=2 WHERE id=$1", [source]);
        await writerClient.query("UPDATE world_locations SET name='Dock' WHERE id=$1", [location]);
        await writerClient.query("INSERT INTO game_turns(session_id,turn_number,role,content) VALUES ($1,2,'narrator','Dock opens')", [source]);
        await writerClient.query("COMMIT");
      } catch (error) {
        await writerClient.query("ROLLBACK");
        throw error;
      } finally { writerClient.release(); }
      release();
      const frozen = await concurrentExport;
      assert.equal(frozen!.snapshot.session.worldState.currentLocation, "Market");
      assert.equal(frozen!.snapshot.locations[0].name, "Market");
      assert.equal(frozen!.snapshot.turns.length, 1);
    } finally {
      release();
      connectMock.mock.restore();
      await writer.end();
    }
    const document = (await exportPortableCampaign(source, owner))!;
    assert.equal(document.snapshot.turns.length, 2);
    const request = { profileId: importer, requestId: "twelve-contenders", document, title: "Imported Harbor" };
    const results = await Promise.all(Array.from({ length: 12 }, () => importCampaign(request)));
    assert.equal(results.filter(result => !result.replay).length, 1);
    assert.equal(results.filter(result => result.replay).length, 11);
    assert.equal(new Set(results.map(result => result.session.id)).size, 1);
    const target = results[0].session.id;
    assert.equal(Number((await pool.query("SELECT count(*)::int n FROM game_sessions WHERE owner_id=$1", [importer])).rows[0].n), 1);
    assert.equal(Number((await pool.query("SELECT count(*)::int n FROM campaign_imports WHERE owner_id=$1", [importer])).rows[0].n), 1);
    await assert.rejects(() => importCampaign({ ...request, title: "Changed title" }), error => (error as { code?: string }).code === "IDEMPOTENCY_CONFLICT");
    const changed = structuredClone(document);
    changed.snapshot.session.worldState.flags.changed = true;
    changed.checksum = snapshotChecksum(changed.snapshot);
    await assert.rejects(() => importCampaign({ ...request, document: changed }), error => (error as { code?: string }).code === "IDEMPOTENCY_CONFLICT");
    await pool.query("DELETE FROM game_sessions WHERE id=$1", [target]);
    await assert.rejects(() => importCampaign(request), error => (error as { code?: string }).code === "IMPORT_DELETED");
    assert.equal(Number((await pool.query("SELECT count(*)::int n FROM game_sessions WHERE owner_id=$1", [importer])).rows[0].n), 0);
    assert.equal((await pool.query("SELECT campaign_id FROM campaign_imports WHERE owner_id=$1", [importer])).rows[0].campaign_id, null);
  } finally {
    await pool.end();
    await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`);
    await bootstrap.end();
  }
});
