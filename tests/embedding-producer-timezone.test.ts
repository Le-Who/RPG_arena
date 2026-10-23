import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountsDb } from "./helpers/accounts-db";
import { portableFixture } from "./helpers/portable-fixture";
import { createPortableDocument } from "../src/lib/campaign-portable";
import { copyCampaign, importCampaign } from "../src/lib/campaign-copy";
import { createCheckpoint, forkCheckpoint } from "../src/lib/checkpoints";
import { indexPendingEmbeddings } from "../src/lib/embeddings";
import { EMBEDDING_MODEL } from "../src/lib/vector";

test("campaign copy, import and checkpoint fork immediately index embeddings created under a non-UTC timezone", async t => {
  const fixture = await accountsDb();
  const ownerId = `embedding-producer-${randomUUID()}`;
  const document = createPortableDocument(portableFixture());
  const vector = [1, ...Array<number>(127).fill(0)];
  const transport = mock.method(globalThis, "fetch", async () => Response.json({ embedding: { values: vector } }));
  try {
    await fixture.pg.query("INSERT INTO ai_settings(id,enforce_limits,embedding_dims) VALUES ($1,false,128)", [ownerId]);
    const source = await importCampaign({ profileId: ownerId, requestId: "source-import", document });
    const checkpoint = await createCheckpoint({ sessionId: source.session.id, title: "Исходная точка", requestId: "source-checkpoint" });
    await fixture.pg.exec("SET TIME ZONE 'Asia/Tokyo'");
    const producers = {
      copy: () => copyCampaign({ profileId: ownerId, sessionId: source.session.id, requestId: "timezone-copy" }),
      import: () => importCampaign({ profileId: ownerId, requestId: "timezone-import", document }),
      fork: () => forkCheckpoint({ sessionId: source.session.id, checkpointId: checkpoint.checkpoint.id, title: "Новая ветка", requestId: "timezone-fork" }),
    };
    for (const [kind, produce] of Object.entries(producers)) await t.test(kind, async () => {
      const campaign = await produce();
      assert.deepEqual(await indexPendingEmbeddings({ sessionId: campaign.session.id, keys: ["synthetic-embedding-key"], model: EMBEDDING_MODEL, dims: 128 }),
        { indexed: 1, failed: 0, pending: 0 });
      assert.deepEqual((await fixture.pg.query("SELECT status,attempts,vector FROM memory_embeddings WHERE session_id=$1", [campaign.session.id])).rows,
        [{ status: "ready", attempts: 1, vector }]);
    });
  } finally { transport.mock.restore(); await fixture.close(); }
});
