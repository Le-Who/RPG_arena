import test from "node:test";
import assert from "node:assert/strict";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { SCENARIOS } from "../src/lib/scenarios";

test("preset creation rejects nonnumeric character indices before persisting campaign data", async () => {
  const fixture = await accountsDb();
  try {
    const { POST } = await import("../src/app/api/sessions/route");
    const afterJobs: (() => Promise<void>)[] = [];
    for (const characterIndex of ["__proto__", "constructor", [], {}, null, -1, 0.5]) {
      const response = await cookieContext(`chronicle_guest=${"7".repeat(64)}`, () => POST(new Request("https://game.test/api/sessions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "preset", scenarioId: SCENARIOS[0].id, characterIndex }),
      })), afterJobs);
      assert.equal(response.status, 400, JSON.stringify(characterIndex));
      assert.equal((await fixture.pg.query<{ n: number }>("SELECT count(*)::int AS n FROM game_sessions")).rows[0].n, 0);
      assert.equal(afterJobs.length, 0);
    }
    for (const characterIndex of [undefined, 0, 999]) {
      const response = await cookieContext(`chronicle_guest=${"7".repeat(64)}`, () => POST(new Request("https://game.test/api/sessions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "preset", scenarioId: SCENARIOS[0].id, characterIndex }),
      })), afterJobs);
      assert.equal(response.status, 200, await response.clone().text());
      const { session } = await response.json();
      assert.equal(session.character.name, SCENARIOS[0].characters[0].name);
      assert.equal(session.rulesProfile, SCENARIOS[0].rulesProfile);
    }
  } finally { await fixture.close(); }
});
