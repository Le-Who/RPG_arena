import test from "node:test";
import assert from "node:assert/strict";
import { accountsDb, cookieContext } from "./helpers/accounts-db";

test("image task route validates the provider and passes only current owner/key-scoped Pollinations models", async () => {
  const f = await accountsDb(), originalFetch = global.fetch;
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ test: Buffer.alloc(32, 42).toString("base64") }); process.env.CHRONICLE_SECRET_ACTIVE_KEY = "test";
  try {
    const { auth } = await import("../src/lib/auth");
    const { attachPollinationsKey } = await import("../src/lib/text-provider-settings");
    const { GET } = await import("../src/app/api/settings/visual-provider/models/route");
    const account = await auth.register("8".repeat(64), "imageroute", "correct horse battery staple");
    await attachPollinationsKey(account.identity.profileId, "sk_image_route_fixture");
    const identity = `chronicle_guest=${account.guestToken}; chronicle_session=${account.sessionToken}`;
    let allowed = ["vendor/allowed"], calls = 0;
    global.fetch = async (url, init) => {
      calls++; assert.equal(new Headers(init?.headers).get("authorization"), "Bearer sk_image_route_fixture");
      if (String(url).endsWith("/account/key")) return Response.json({ valid: true, permissions: { models: allowed } });
      const base = { category: "image", input_modalities: ["text"], output_modalities: ["image"], supported_endpoints: ["/image/{prompt}"] };
      return Response.json([{ ...base, name: "vendor/allowed", flat_rate: true, pricing: { currency: "pollen", completionImageTokens: "0.04" } }, { ...base, name: "vendor/denied" }]);
    };
    const invalid = await cookieContext(identity, () => GET(new Request("https://fixture.test/api/settings/visual-provider/models?provider=evil")));
    assert.equal(invalid.status, 400); assert.equal(calls, 0);
    const first = await cookieContext(identity, () => GET(new Request("https://fixture.test/api/settings/visual-provider/models?provider=pollinations")));
    assert.equal(first.status, 200); assert.equal(first.headers.get("cache-control"), "private, no-store");
    const body = await first.json(); assert.deepEqual(body.models.map((model: { id: string }) => model.id), ["vendor/allowed"]); assert.equal(body.models[0].price.amount, 0.04);
    allowed = ["vendor/denied"];
    const second = await cookieContext(identity, () => GET(new Request("https://fixture.test/api/settings/visual-provider/models?provider=pollinations")));
    assert.deepEqual((await second.json()).models.map((model: { id: string }) => model.id), ["vendor/denied"]);
    assert.equal(calls, 3); assert.ok(!JSON.stringify(body).includes("sk_image_route_fixture"));
  } finally { global.fetch = originalFetch; delete process.env.CHRONICLE_SECRET_KEYS; delete process.env.CHRONICLE_SECRET_ACTIVE_KEY; await f.close(); }
});
