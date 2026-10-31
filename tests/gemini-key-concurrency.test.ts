import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { newGuestToken, profileIdFromToken } from "../src/lib/guest-identity";
import { openSecret, secretContext } from "../src/lib/secret-vault";

// A completed credential write between the preliminary settings read and the
// mutation must survive. The HTTP handler, SQL and secret sealing remain real.
for (const scenario of ["append", "replace", "clear", "remove-replace"] as const) {
  const removal = scenario === "clear" || scenario === "remove-replace";
  test(`Gemini ${removal ? "removal rejects a changed list" : "append uses committed keys"} after a concurrent ${scenario}`, async () => {
    const fixture = await accountsDb();
    const { pool } = await import("../src/db");
    const { POST } = await import("../src/app/api/settings/route");
    const { saveProviderConnection } = await import("../src/lib/text-provider-settings");
    const guest = newGuestToken(), owner = profileIdFromToken(guest)!;
    process.env.CHRONICLE_SECRET_ACTIVE_KEY = "concurrency";
    process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ concurrency: Buffer.alloc(32, 37).toString("base64") });
    const send = (body: Record<string, unknown>) => cookieContext(`chronicle_guest=${guest}`, () => POST(new Request("http://local/api/settings", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    })));
    let query: ReturnType<typeof mock.method> | undefined;
    try {
      assert.equal((await send({ keysText: "synthetic-initial-key synthetic-second-key", append: false })).status, 200);
      let interleaved = false;
      query = mock.method(pool, "query", async (...args: Parameters<typeof fixture.run>) => {
        const sql = typeof args[0] === "string" ? args[0] : args[0].text;
        const result = await fixture.run(...args);
        if (!interleaved && /^select .* from "ai_settings"/i.test(sql)) {
          interleaved = true;
          if (scenario === "append") assert.equal((await send({ keysText: "synthetic-concurrent-key", append: true })).status, 200);
          else await saveProviderConnection(owner, scenario === "replace" || scenario === "remove-replace"
            ? { provider: "gemini", apiKey: "synthetic-replacement-key" }
            : { provider: "gemini", clearKey: true });
        }
        return result;
      });
      const response = await send(removal ? { removeIndex: [0] } : { keysText: "synthetic-later-key", append: true });
      assert.equal(response.status, removal ? 409 : 200);
      assert.equal(interleaved, true);
      const row = (await fixture.pg.query<{ keys: string[] }>("SELECT keys FROM ai_settings WHERE id=$1", [owner])).rows[0];
      const keys = row.keys.map(key => openSecret(key, secretContext(owner, "gemini")));
      const expected = scenario === "append" ? ["synthetic-initial-key", "synthetic-second-key", "synthetic-concurrent-key", "synthetic-later-key"]
        : scenario === "replace" ? ["synthetic-replacement-key", "synthetic-later-key"]
        : scenario === "remove-replace" ? ["synthetic-replacement-key"] : [];
      assert.deepEqual(keys, expected);
      const view = await response.json();
      if (removal) assert.equal(view.code, "SETTINGS_CHANGED");
      else assert.equal(view.keysCount, expected.length);
    } finally {
      query?.mock.restore();
      await fixture.close();
      delete process.env.CHRONICLE_SECRET_ACTIVE_KEY;
      delete process.env.CHRONICLE_SECRET_KEYS;
    }
  });
}
