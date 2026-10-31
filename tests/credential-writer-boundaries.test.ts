import test from "node:test";
import assert from "node:assert/strict";
import { accountsDb, cookieContext } from "./helpers/accounts-db";
import { newGuestToken, profileIdFromToken } from "../src/lib/guest-identity";

test("obsolete narrator credential payloads cannot overwrite shared provider connections", async () => {
  const f = await accountsDb();
  process.env.CHRONICLE_SECRET_ACTIVE_KEY = "writer";
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ writer: Buffer.alloc(32, 51).toString("base64") });
  try {
    const { saveProviderConnection } = await import("../src/lib/text-provider-settings");
    const { POST } = await import("../src/app/api/settings/text-provider/route");
    const guest = newGuestToken(), owner = profileIdFromToken(guest)!;
    await saveProviderConnection(owner, { provider: "openrouter", apiKey: "synthetic-current-router" });
    await saveProviderConnection(owner, { provider: "pollinations", apiKey: "synthetic-current-pollen" });
    const before = (await f.pg.query("SELECT * FROM ai_settings WHERE id=$1", [owner])).rows[0];
    for (const provider of ["openrouter", "pollinations"]) for (const mutation of [{ apiKey: "synthetic-obsolete-key" }, { clearKey: true }]) {
      const response = await cookieContext(`chronicle_guest=${guest}`, () => POST(new Request("http://local/api/settings/text-provider", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider, model: "synthetic/model", ...mutation }),
      })));
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "INVALID_INPUT");
      assert.deepEqual((await f.pg.query("SELECT * FROM ai_settings WHERE id=$1", [owner])).rows[0], before);
    }
  } finally {
    delete process.env.CHRONICLE_SECRET_ACTIVE_KEY; delete process.env.CHRONICLE_SECRET_KEYS;
    await f.close();
  }
});

test("successful Gemini accounting and configuration reads leave every stored encrypted key unchanged", async () => {
  const f = await accountsDb();
  process.env.CHRONICLE_SECRET_ACTIVE_KEY = "writer";
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ writer: Buffer.alloc(32, 51).toString("base64") });
  try {
    const { getAIConfig, logToken, prepareGeminiKeysWrite } = await import("../src/lib/ai-settings");
    const guest = newGuestToken(), owner = profileIdFromToken(guest)!;
    const plaintext = ["synthetic-gemini-one", "synthetic-gemini-two", "synthetic-gemini-three"];
    const encrypted = prepareGeminiKeysWrite(owner, plaintext);
    await f.pg.query("INSERT INTO ai_settings(id,keys,use_live_ai) VALUES ($1,$2::jsonb,true)", [owner, JSON.stringify(encrypted)]);
    for (let keyIndex = 0; keyIndex < 3; keyIndex++) {
      assert.deepEqual((await getAIConfig(owner)).keys, plaintext);
      await cookieContext(`chronicle_guest=${guest}`, () => logToken({ sessionId: null, model: "gemini-3.5-flash-lite", taskType: "narration", promptTokens: 5, completionTokens: 3, latencyMs: 1, success: true, keyIndex }));
      assert.deepEqual((await f.pg.query<{ keys: string[] }>("SELECT keys FROM ai_settings WHERE id=$1", [owner])).rows[0].keys, encrypted);
    }
    assert.equal((await f.pg.query<{ count: number }>("SELECT count(*)::int count FROM token_logs WHERE owner_id=$1 AND success=true", [owner])).rows[0].count, 3);
  } finally {
    delete process.env.CHRONICLE_SECRET_ACTIVE_KEY; delete process.env.CHRONICLE_SECRET_KEYS;
    await f.close();
  }
});
