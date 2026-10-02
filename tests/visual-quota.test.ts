import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountsDb } from "./helpers/accounts-db";
import { HttpError } from "../src/lib/http";

test("deleting a visual does not restore its owner's daily generation quota", async () => {
  const fixture = await accountsDb();
  const previousKey = process.env.POLLINATIONS_API_KEY;
  const previousLimit = process.env.CHRONICLE_VISUAL_DAILY_LIMIT;
  try {
    process.env.POLLINATIONS_API_KEY = "fixture-only";
    process.env.CHRONICLE_VISUAL_DAILY_LIMIT = "1";
    const sessionId = randomUUID();
    await fixture.pg.query(
      `INSERT INTO game_sessions(id, owner_id, title, character, world_state)
       VALUES ($1, 'guest-owner', 'Visual quota',
         '{"name":"Hero","archetype":"writer","appearance":"dark hair"}',
         '{"worldName":"City","tone":"everyday","era":"today","currentLocation":"Cafe"}')`,
      [sessionId],
    );
    const { createVisual, deleteVisual } = await import("../src/lib/visuals");

    const first = await createVisual(sessionId, { kind: "portrait", subject: "hero" });
    await deleteVisual(sessionId, first.id);

    assert.equal((await fixture.pg.query<{ n: number }>("SELECT count(*)::int n FROM scene_visuals")).rows[0].n, 0);
    assert.equal((await fixture.pg.query<{ n: number }>("SELECT count(*)::int n FROM visual_quota_reservations")).rows[0].n, 1);
    await assert.rejects(
      () => createVisual(sessionId, { kind: "portrait", subject: "hero" }),
      error => error instanceof HttpError && error.status === 429 && error.code === "VISUAL_QUOTA",
    );
  } finally {
    if (previousKey === undefined) delete process.env.POLLINATIONS_API_KEY;
    else process.env.POLLINATIONS_API_KEY = previousKey;
    if (previousLimit === undefined) delete process.env.CHRONICLE_VISUAL_DAILY_LIMIT;
    else process.env.CHRONICLE_VISUAL_DAILY_LIMIT = previousLimit;
    await fixture.close();
  }
});
