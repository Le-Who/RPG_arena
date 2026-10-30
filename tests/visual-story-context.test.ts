import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { profileIdFromToken } from "../src/lib/guest-identity";

test("portraits, places and scenes receive bounded current story context and optional visual override", async () => {
  const f = await accountsDb();
  process.env.POLLINATIONS_API_KEY = "synthetic-pollen-context";
  try {
    const { createVisual } = await import("../src/lib/visuals");
    const session = randomUUID();
    await f.pg.query(`INSERT INTO game_sessions(id,owner_id,title,scenario_prompt,character,world_state) VALUES ($1,'visual-context-owner','SERVICE_TITLE_SENTINEL','FULL_SCENARIO_SECRET_SENTINEL', $2::jsonb,$3::jsonb)`, [session,
      JSON.stringify({ name: "Пончик", archetype: "архивист", appearance: "седые волосы, тёмное пальто", traits: ["сдержанный"] }),
      JSON.stringify({ worldName: "Промышленный город", tone: "Серьёзная готическая история", era: "XIX век", currentLocation: "Архив", narrator: { realism: "grounded", tension: "tense", note: "Сдержанная тревожная атмосфера" } }),
    ]);
    await f.pg.query("INSERT INTO world_locations(session_id,name,description,current,discovered) VALUES ($1,'Архив','Кирпичное здание',true,true)", [session]);
    await f.pg.query("INSERT INTO game_turns(session_id,role,turn_number,content) VALUES ($1,'narrator',1,'OLD_HISTORY_SENTINEL'),($1,'narrator',2,'Тихий вечер. Пончик стоит у окна архива.')", [session]);
    for (const kind of ["portrait", "location", "scene"] as const) {
      const visual = await createVisual(session, { kind, styleOverride: "Монохромная гравюра" });
      const stored = (await f.pg.query<{ prompt: string }>("SELECT prompt FROM scene_visuals WHERE id=$1", [visual.id])).rows[0].prompt;
      for (const expected of ["Промышленный город", "Серьёзная готическая история", "XIX век", "Монохромная гравюра", "Тихий вечер", "Сдержанная тревожная атмосфера"]) assert.ok(stored.includes(expected), `${kind} missing ${expected}`);
      if (kind !== "location") assert.ok(stored.includes("седые волосы"));
      assert.doesNotMatch(stored, /OLD_HISTORY_SENTINEL|FULL_SCENARIO_SECRET_SENTINEL|SERVICE_TITLE_SENTINEL|visual-context-owner/);
      assert.ok(stored.length <= 2200);
    }
  } finally { delete process.env.POLLINATIONS_API_KEY; await f.close(); }
});

test("visual style HTTP input is bounded and stored in the image prompt without altering campaign settings", async () => {
  const f = await accountsDb();
  process.env.POLLINATIONS_API_KEY = "synthetic-pollen-context";
  try {
    const { POST } = await import("../src/app/api/sessions/[id]/visuals/route");
    const token = "d".repeat(64), owner = profileIdFromToken(token)!, session = randomUUID();
    await f.pg.query("INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,$2,'Fixture','{\"name\":\"Анна\"}','{\"tone\":\"комедия\",\"worldName\":\"Город\",\"currentLocation\":\"Кафе\"}')", [session, owner]);
    const before = (await f.pg.query("SELECT character,world_state FROM game_sessions WHERE id=$1", [session])).rows[0];
    const send = (styleOverride: unknown) => cookieContext(`chronicle_guest=${token}`, () => POST(new Request(`http://local/api/sessions/${session}/visuals`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "portrait", styleOverride }) }), { params: Promise.resolve({ id: session }) }));
    for (const input of [400, {}, ["style"], "x".repeat(401)]) assert.equal((await send(input)).status, 400);
    assert.equal((await f.pg.query<{ count: number }>("SELECT count(*)::int count FROM scene_visuals")).rows[0].count, 0);
    const created = await send("  Лёгкая комичная акварель  ");
    assert.equal(created.status, 201);
    assert.match((await f.pg.query<{ prompt: string }>("SELECT prompt FROM scene_visuals")).rows[0].prompt, /Лёгкая комичная акварель/);
    assert.equal((await send("   ")).status, 201);
    assert.deepEqual((await f.pg.query("SELECT character,world_state FROM game_sessions WHERE id=$1", [session])).rows[0], before);
  } finally { delete process.env.POLLINATIONS_API_KEY; await f.close(); }
});

test("absent NPC portraits and remote places keep their own setting without borrowing the hero's scene", async () => {
  const f = await accountsDb();
  process.env.POLLINATIONS_API_KEY = "synthetic-pollen-context";
  try {
    const { createVisual } = await import("../src/lib/visuals");
    const session = randomUUID(), remote = randomUUID();
    await f.pg.query(`INSERT INTO game_sessions(id,owner_id,title,character,world_state) VALUES ($1,'off-scene-owner','Fixture','{"name":"Анна"}','{"worldName":"Город","tone":"Готическая драма","era":"XIX век","currentLocation":"Архив"}')`, [session]);
    await f.pg.query("INSERT INTO npcs(session_id,key,name,role,description,last_location) VALUES ($1,'boris','Борис','врач','Седая борода, чёрный костюм','Обсерватория')", [session]);
    await f.pg.query("INSERT INTO world_locations(id,session_id,name,description,discovered) VALUES ($1,$2,'Обсерватория','Медный купол',true)", [remote, session]);
    await f.pg.query("INSERT INTO game_turns(session_id,role,turn_number,content) VALUES ($1,'narrator',1,'Анна примеряет красный парик в Архиве.')", [session]);
    for (const input of [{ kind: "portrait" as const, subject: "npc:boris" }, { kind: "location" as const, subject: remote }]) {
      const visual = await createVisual(session, input);
      const prompt = (await f.pg.query<{ prompt: string }>("SELECT prompt FROM scene_visuals WHERE id=$1", [visual.id])).rows[0].prompt;
      assert.match(prompt, /Готическая драма/);
      assert.match(prompt, /Обсерватория/);
      assert.doesNotMatch(prompt, /Архив|Анна|красный парик/);
      assert.match(prompt, input.kind === "portrait" ? /Седая борода/ : /Медный купол/);
    }
  } finally { delete process.env.POLLINATIONS_API_KEY; await f.close(); }
});
