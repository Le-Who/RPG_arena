import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountsDb } from "./helpers/accounts-db";
import { HttpError } from "../src/lib/http";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

async function addCampaign(fixture: Awaited<ReturnType<typeof accountsDb>>, owner: string | null) {
  const id = randomUUID();
  await fixture.pg.query(`INSERT INTO game_sessions(id,owner_id,title,character,world_state)
    VALUES ($1,$2,'Visual quota','{"name":"Hero","archetype":"writer","appearance":"dark hair"}',
    '{"worldName":"City","tone":"everyday","era":"today","currentLocation":"Cafe"}')`, [id, owner]);
  return id;
}

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
    await assert.rejects(
      () => createVisual(sessionId, { kind: "portrait", subject: "hero" }),
      error => error instanceof HttpError && error.status === 429 && error.code === "VISUAL_QUOTA",
    );
    assert.equal((await fixture.pg.query<{ n: number }>("SELECT count(*)::int n FROM visual_quota_reservations")).rows[0].n, 1);
  } finally {
    if (previousKey === undefined) delete process.env.POLLINATIONS_API_KEY;
    else process.env.POLLINATIONS_API_KEY = previousKey;
    if (previousLimit === undefined) delete process.env.CHRONICLE_VISUAL_DAILY_LIMIT;
    else process.env.CHRONICLE_VISUAL_DAILY_LIMIT = previousLimit;
    await fixture.close();
  }
});

test("campaign deletion preserves quota, isolates owners and releases only expired reservations", async () => {
  const fixture = await accountsDb();
  const previousKey = process.env.POLLINATIONS_API_KEY;
  const previousLimit = process.env.CHRONICLE_VISUAL_DAILY_LIMIT;
  try {
    process.env.POLLINATIONS_API_KEY = "fixture-only";
    process.env.CHRONICLE_VISUAL_DAILY_LIMIT = "1";
    const { createVisual } = await import("../src/lib/visuals");
    const source = await addCampaign(fixture, "quota-owner");
    await createVisual(source, { kind: "portrait", subject: "hero" });
    await fixture.pg.query("DELETE FROM game_sessions WHERE id=$1", [source]);
    const next = await addCampaign(fixture, "quota-owner");
    await assert.rejects(() => createVisual(next, { kind: "portrait", subject: "hero" }),
      error => error instanceof HttpError && error.code === "VISUAL_QUOTA");
    const other = await addCampaign(fixture, "other-owner");
    await createVisual(other, { kind: "portrait", subject: "hero" });
    await fixture.pg.query("UPDATE visual_quota_reservations SET created_at=now()-interval '25 hours' WHERE quota_scope='owner:quota-owner'");
    await createVisual(next, { kind: "portrait", subject: "hero" });
    assert.equal((await fixture.pg.query<{ n: number }>("SELECT count(*)::int n FROM visual_quota_reservations")).rows[0].n, 3);
  } finally {
    if (previousKey === undefined) delete process.env.POLLINATIONS_API_KEY; else process.env.POLLINATIONS_API_KEY = previousKey;
    if (previousLimit === undefined) delete process.env.CHRONICLE_VISUAL_DAILY_LIMIT; else process.env.CHRONICLE_VISUAL_DAILY_LIMIT = previousLimit;
    await fixture.close();
  }
});

test("quota migration backfills the campaign's current owner after guest adoption", async () => {
  const pg = new PGlite({ extensions: { vector, pgcrypto } });
  try {
    for (const file of (await readdir("drizzle")).filter(x => /^\d{4}_.*\.sql$/.test(x) && !x.startsWith("0019_")).sort()) await pg.exec(await readFile(`drizzle/${file}`, "utf8"));
    const session = randomUUID();
    const visual = randomUUID();
    await pg.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,'current-owner','Quota','{}','{}')", [session]);
    await pg.query(`INSERT INTO scene_visuals(id,session_id,owner_id,kind,subject_key,caption,prompt,provider,model,seed,width,height,created_at)
      VALUES ($1,$2,'former-guest','portrait','hero','Hero','Hero','pollinations','flux',1,768,960,'2026-09-30T12:00:00Z')`, [visual, session]);
    await pg.exec(await readFile("drizzle/0019_visual_quota_reservations.sql", "utf8"));
    const rows = (await pg.query<{ quota_scope: string; visual_id: string; created_at: Date }>("SELECT quota_scope,visual_id,created_at FROM visual_quota_reservations")).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].quota_scope, "owner:current-owner");
    assert.equal(rows[0].visual_id, visual);
    assert.equal(new Date(rows[0].created_at).toISOString(), "2026-09-30T12:00:00.000Z");
  } finally { await pg.close(); }
});

test("adopting a guest campaign carries its consumed visual quota to the account", async () => {
  const fixture = await accountsDb();
  const previousKey = process.env.POLLINATIONS_API_KEY;
  const previousLimit = process.env.CHRONICLE_VISUAL_DAILY_LIMIT;
  try {
    process.env.POLLINATIONS_API_KEY = "fixture-only";
    process.env.CHRONICLE_VISUAL_DAILY_LIMIT = "1";
    const { profileIdFromToken } = await import("../src/lib/guest-identity");
    const { tokenHash } = await import("../src/lib/auth-policy");
    const { auth } = await import("../src/lib/auth");
    const { createVisual, deleteVisual } = await import("../src/lib/visuals");
    const guestToken = "4".repeat(64), sessionToken = "5".repeat(64), account = randomUUID();
    await fixture.pg.query("INSERT INTO accounts(id,login,profile_id,password_hash) VALUES ($1,'quota-account','account-owner','fixture-only')", [account]);
    await fixture.pg.query("INSERT INTO account_sessions(token_hash,account_id,expires_at) VALUES ($1,$2,now()+interval '1 hour')", [tokenHash(sessionToken), account]);
    const guestCampaign = await addCampaign(fixture, profileIdFromToken(guestToken));
    const visual = await createVisual(guestCampaign, { kind: "portrait", subject: "hero" });
    await deleteVisual(guestCampaign, visual.id);
    await auth.adopt(guestToken, sessionToken);
    const target = await addCampaign(fixture, "account-owner");
    await assert.rejects(() => createVisual(target, { kind: "portrait", subject: "hero" }),
      error => error instanceof HttpError && error.code === "VISUAL_QUOTA");
  } finally {
    if (previousKey === undefined) delete process.env.POLLINATIONS_API_KEY; else process.env.POLLINATIONS_API_KEY = previousKey;
    if (previousLimit === undefined) delete process.env.CHRONICLE_VISUAL_DAILY_LIMIT; else process.env.CHRONICLE_VISUAL_DAILY_LIMIT = previousLimit;
    await fixture.close();
  }
});
