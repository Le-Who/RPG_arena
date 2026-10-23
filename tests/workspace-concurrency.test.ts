import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { profileIdFromToken } from "../src/lib/guest-identity";
import { SCENARIOS } from "../src/lib/scenarios";

const favorites = [SCENARIOS[0].id];
const reading = { textScale: "large", measure: "wide", theme: "sepia", motion: "reduced" };
for (const [delayed, concurrent] of [
  [{ favorites }, { reading }],
  [{ reading }, { displayName: "Новое имя" }],
  [{ displayName: "Новое имя" }, { favorites }],
]) {
  test(`concurrent workspace ${Object.keys(delayed)[0]} and ${Object.keys(concurrent)[0]} saves retain both successful changes`, { timeout: 20_000 }, async () => {
    const fixture = await accountsDb();
    const { pool } = await import("../src/db");
    const { PATCH } = await import("../src/app/api/workspace/route");
    const guest = "8".repeat(64), owner = profileIdFromToken(guest)!;
    await fixture.pg.query("INSERT INTO workspace_preferences(id) VALUES ($1)", [owner]);
    let release!: () => void, entered!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    let held = false;
    const trap = mock.method(pool, "query", async (...args: Parameters<typeof fixture.run>) => {
      const query = args[0], sql = typeof query === "string" ? query : query.text;
      if (!held && sql.startsWith('update "workspace_preferences"')) { held = true; entered(); await hold; }
      return fixture.run(...args);
    });
    const patch = (body: unknown) => cookieContext(`chronicle_guest=${guest}`, () => PATCH(new Request("https://game.test/api/workspace", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    })));
    let first: Promise<Response> | undefined;
    try {
      first = patch(delayed);
      await ready;
      assert.equal((await patch(concurrent)).status, 200);
      release();
      assert.equal((await first).status, 200);
      const row = (await fixture.pg.query<{ favorites: string[]; reading: unknown; displayName: string }>(
        'SELECT favorites, reading, display_name AS "displayName" FROM workspace_preferences WHERE id=$1', [owner],
      )).rows[0];
      const expected = { ...delayed, ...concurrent };
      for (const [field, value] of Object.entries(expected)) assert.deepEqual(row[field as keyof typeof row], value, `successful ${field} write must survive`);
    } finally { release(); await first?.catch(() => {}); trap.mock.restore(); await fixture.close(); }
  });
}
