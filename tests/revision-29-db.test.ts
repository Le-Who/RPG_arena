import test, { mock } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cookieContext } from "./helpers/accounts-db";
import { newGuestToken, profileIdFromToken } from "../src/lib/guest-identity";
import { portableFixture } from "./helpers/portable-fixture";
import type { WorldState } from "../src/db/schema";

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

test("arc continuation is owner-only, atomic, non-repeatable and exported with its archived epilogue", async () => {
  const fixture = await portableDb();
  try {
    const token = newGuestToken(), stranger = newGuestToken(), owner = profileIdFromToken(token)!;
    const id = randomUUID(), snapshot = portableFixture();
    const world: WorldState = { ...snapshot.session.worldState, mainQuest: "Старая цель", clock: { day: 3, minute: 500 },
      story: { kind: "arc", goal: "Старая цель", stakes: "Дом", conflict: "Долг", endCondition: "Долг погашен", status: "resolved", focus: [], resolvedTurn: 3, epilogue: "Архивный эпилог <script>alert(1)</script>" } };
    await fixture.pg.query("INSERT INTO game_sessions(id,owner_id,visibility,title,character,world_state,turn_count) VALUES ($1,$2,'private','Книга',$3,$4,3)", [id, owner, JSON.stringify(snapshot.session.character), JSON.stringify(world)]);
    await fixture.pg.query("INSERT INTO world_locations(session_id,name,current,discovered) VALUES ($1,$2,true,true)", [id, world.currentLocation]);
    await fixture.pg.query("INSERT INTO game_turns(session_id,turn_number,role,content) VALUES ($1,3,'narrator','Долг погашен.')", [id]);
    await fixture.pg.query("INSERT INTO quests(session_id,key,title,status,progress,is_main) VALUES ($1,'old','Старая цель','completed',100,true)", [id]);
    const { PATCH } = await import("../src/app/api/sessions/[id]/route");
    const { GET } = await import("../src/app/api/sessions/[id]/export/route");
    const context = { params: Promise.resolve({ id }) };
    const body = { storyShape: { continueAs: "arc", goal: "Новая цель", stakes: "Семья", conflict: "Переезд", endCondition: "Новоселье" } };
    const patch = (t: string, b: unknown) => cookieContext(`chronicle_guest=${t}`, () => PATCH(new Request(`http://localhost/api/sessions/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }), context));
    assert.equal((await patch(stranger, body)).status, 404);
    assert.equal((await patch(token, { storyShape: { continueAs: "arc", goal: "Incomplete" } })).status, 400);
    const before = (await fixture.pg.query<{ world_state: WorldState }>("SELECT world_state FROM game_sessions WHERE id=$1", [id])).rows[0].world_state;
    assert.deepEqual(before, world);
    const response = await patch(token, body);
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.session.worldState.mainQuest, "Новая цель");
    assert.equal(result.session.worldState.arcHistory.length, 1);
    assert.equal((await patch(token, body)).status, 400, "a retry must not duplicate the archive or quest");
    const goals = (await fixture.pg.query<{ title: string; is_main: boolean; status: string }>("SELECT title,is_main,status FROM quests WHERE session_id=$1 ORDER BY title", [id])).rows;
    assert.deepEqual(goals, [{ title: "Новая цель", is_main: true, status: "active" }, { title: "Старая цель", is_main: false, status: "completed" }]);
    const get = (t: string, format: string) => cookieContext(`chronicle_guest=${t}`, () => GET(new Request(`http://localhost/api/sessions/${id}/export?format=${format}`), context));
    assert.equal((await get(stranger, "html")).status, 404);
    const html = await get(token, "html");
    assert.equal(html.status, 200);
    assert.equal(html.headers.get("Cache-Control"), "private, no-store");
    assert.match(html.headers.get("Content-Security-Policy")!, /default-src 'none'/);
    const book = await html.text();
    assert.match(book, /Архивный эпилог &lt;script&gt;/);
    assert.ok(!book.includes("<script>"));
    assert.match(await (await get(token, "markdown")).text(), /Завершённая арка 1/);
    const portable = await get(token, "json");
    assert.equal(portable.status, 200, await portable.clone().text());
    assert.match(await portable.text(), /arcHistory/);
  } finally { await fixture.close(); }
});
