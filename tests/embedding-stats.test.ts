import test from "node:test";
import assert from "node:assert/strict";
import { accountsDb } from "./helpers/accounts-db";

test("embedding statistics sum each status across persisted model versions and isolate campaigns", async () => {
  const fixture = await accountsDb();
  try {
    const { embeddingStats } = await import("../src/lib/embeddings");
    const session = "00000000-0000-4000-8000-000000000001";
    const other = "00000000-0000-4000-8000-000000000002";
    await fixture.pg.query("INSERT INTO game_sessions(id,title,character,world_state) VALUES ($1,'One','{}','{}'),($2,'Two','{}','{}')", [session, other]);
    for (const [campaign, model, status, count] of [
      [session, "legacy-embedding", "ready", 2],
      [session, "gemini-embedding-2", "ready", 3],
      [session, "legacy-embedding", "pending", 1],
      [session, "gemini-embedding-2", "pending", 2],
      [session, "gemini-embedding-2", "failed", 1],
      [other, "gemini-embedding-2", "ready", 4],
    ] as const) {
      for (let i = 0; i < count; i++) {
        const node = (await fixture.pg.query<{ id: string }>("INSERT INTO memory_nodes(session_id,layer,category,title,content,content_hash) VALUES ($1,'semantic','fact','Fact','Remembered','hash') RETURNING id", [campaign])).rows[0];
        await fixture.pg.query("INSERT INTO memory_embeddings(memory_node_id,session_id,model,dims,status,content_hash) VALUES ($1,$2,$3,768,$4,'hash')", [node.id, campaign, model, status]);
      }
    }
    const result = await embeddingStats(session);
    assert.deepEqual({ ...result, models: [...result.models].sort() }, {
      nodes: 9, ready: 5, pending: 3, processing: 0, failed: 1,
      models: ["gemini-embedding-2", "legacy-embedding"],
    });
  } finally { await fixture.close(); }
});
