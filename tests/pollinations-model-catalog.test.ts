import test from "node:test";
import assert from "node:assert/strict";
import { accountsDb, cookieContext } from "./helpers/accounts-db";

test("account catalog filters capabilities, aliases, paid restrictions and model permissions, caches metadata and fails closed on revocation", async () => {
  const f = await accountsDb(), originalFetch = global.fetch;
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ test: Buffer.alloc(32, 42).toString("base64") }); process.env.CHRONICLE_SECRET_ACTIVE_KEY = "test";
  try {
    const { attachPollinationsKey } = await import("../src/lib/text-provider-settings");
    const { loadPollinationsModels } = await import("../src/lib/pollinations-model-catalog");
    await attachPollinationsKey("catalog-owner", "sk_catalog_fixture");
    const base = { category: "image", input_modalities: ["text"], output_modalities: ["image"], supported_endpoints: ["/image/{prompt}"] };
    let catalogCalls = 0, revoked = false, failingCatalog = false;
    global.fetch = async (url, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer sk_catalog_fixture");
      if (String(url).endsWith("/account/key")) return revoked ? Response.json({ error: "private-error" }, { status: 401 })
        : Response.json({ valid: true, permissions: { models: ["old-alias", "vendor/paid"] }, questPollenOnly: true });
      catalogCalls++;
      if (failingCatalog) return new Response(null, { status: 503 });
      return Response.json([
        { ...base, name: "vendor/allowed", title: "Allowed", aliases: ["old-alias"] },
        { ...base, name: "vendor/denied" }, { ...base, name: "vendor/paid", paid_only: true },
        { ...base, name: "vendor/video", output_modalities: ["video"] },
        { ...base, name: "vendor/edit-only", input_modalities: ["image"] },
      ]);
    };
    const first = await loadPollinationsModels("catalog-owner", "image");
    assert.deepEqual(first.models.map(m => m.id), ["vendor/allowed"]);
    assert.equal(first.personal, true); assert.equal(first.stale, false);
    const second = await loadPollinationsModels("catalog-owner", "image"); assert.equal(catalogCalls, 1);
    second.models[0].id = "mutated";
    failingCatalog = true;
    const stale = await loadPollinationsModels("catalog-owner", "image", true);
    assert.equal(stale.stale, true); assert.equal(stale.models[0].id, "vendor/allowed");
    revoked = true;
    await assert.rejects(loadPollinationsModels("catalog-owner", "image"), /Pollinations/);
    assert.ok(!JSON.stringify(first).includes("sk_catalog_fixture"));
  } finally { global.fetch = originalFetch; delete process.env.CHRONICLE_SECRET_KEYS; delete process.env.CHRONICLE_SECRET_ACTIVE_KEY; await f.close(); }
});

test("catalog transport finishes on deadline when upstream fetch ignores cancellation", async t => {
  const f = await accountsDb(), originalFetch = global.fetch;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  try {
    const { loadPollinationsModels } = await import("../src/lib/pollinations-model-catalog");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    global.fetch = async () => { entered(); return new Promise<Response>(() => {}); };
    const pending = loadPollinationsModels("deadline-catalog-owner", "text", true);
    const rejected = assert.rejects(pending, /Pollinations/);
    await started; t.mock.timers.tick(8000); await rejected;
  } finally { global.fetch = originalFetch; t.mock.timers.reset(); await f.close(); }
});

test("owner image catalog excludes real text+image edit aliases and preserves prices and optional references", async () => {
  const f = await accountsDb(), originalFetch = global.fetch;
  try {
    const { loadPollinationsModels } = await import("../src/lib/pollinations-model-catalog");
    const base = { category: "image", input_modalities: ["text", "image"], output_modalities: ["image"], supported_endpoints: ["/image/{prompt}"] };
    global.fetch = async () => Response.json([
      { ...base, name: "prunaai/p-image-edit", aliases: ["pruna-edit"] },
      { ...base, name: "renamed/edit", aliases: ["p-image-edit"] },
      { ...base, name: "black-forest-labs/flux.1-kontext-pro", aliases: ["kontext"], pricing: { currency: "pollen", completionImageTokens: "0.03" }, flat_rate: true },
    ]);
    const catalog = await loadPollinationsModels("capability-owner", "image", true);
    assert.deepEqual(catalog.models.map(model => model.id), ["black-forest-labs/flux.1-kontext-pro"]);
    assert.equal(catalog.models[0].price?.amount, 0.03);
    assert.equal(catalog.models[0].generationSupported, true);
  } finally { global.fetch = originalFetch; await f.close(); }
});

test("personal catalogs stay owner-scoped and a session revoked during discovery receives no private models", async () => {
  const f = await accountsDb(), originalFetch = global.fetch;
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ test: Buffer.alloc(32, 42).toString("base64") }); process.env.CHRONICLE_SECRET_ACTIVE_KEY = "test";
  let release!: () => void, entered!: () => void;
  const catalogEntered = new Promise<void>(resolve => { entered = resolve; }), catalogRelease = new Promise<void>(resolve => { release = resolve; });
  let pending: Promise<Response> | undefined;
  try {
    const { auth } = await import("../src/lib/auth");
    const { attachPollinationsKey } = await import("../src/lib/text-provider-settings");
    const { loadPollinationsModels } = await import("../src/lib/pollinations-model-catalog");
    const { GET } = await import("../src/app/api/settings/pollinations/models/route");
    const account = await auth.register("7".repeat(64), "catalograce", "correct horse battery staple");
    await attachPollinationsKey(account.identity.profileId, "sk_catalog_private_account");
    await attachPollinationsKey("catalog-other-owner", "sk_catalog_private_other");
    const base = { category: "text", input_modalities: ["text"], output_modalities: ["text"], supported_endpoints: ["/v1/chat/completions"] };
    let delay = false;
    global.fetch = async (url, init) => {
      const key = new Headers(init?.headers).get("authorization");
      assert.ok(["Bearer sk_catalog_private_account", "Bearer sk_catalog_private_other"].includes(key!));
      if (String(url).endsWith("/account/key")) return Response.json({ valid: true, permissions: { models: null } });
      if (delay) { entered(); await catalogRelease; }
      return Response.json([{ ...base, name: key!.endsWith("_account") ? "private/account" : "private/other" }]);
    };
    assert.deepEqual((await loadPollinationsModels(account.identity.profileId, "text")).models.map(m => m.id), ["private/account"]);
    assert.deepEqual((await loadPollinationsModels("catalog-other-owner", "text")).models.map(m => m.id), ["private/other"]);
    assert.deepEqual((await loadPollinationsModels(account.identity.profileId, "text")).models.map(m => m.id), ["private/account"]);
    delay = true;
    const identity = `chronicle_guest=${account.guestToken}; chronicle_session=${account.sessionToken}`;
    pending = cookieContext(identity, () => GET(new Request("https://fixture.test/api/settings/pollinations/models?kind=text&refresh=1")));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([catalogEntered, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Catalog request did not enter remote discovery")), 8000); })]); }
    finally { clearTimeout(timer); }
    await auth.logout(account.sessionToken); release();
    const response = await pending;
    assert.equal(response.status, 401);
    const body = await response.text();
    assert.ok(!body.includes("private/account")); assert.ok(!body.includes("sk_catalog"));
    assert.equal((await f.pg.query<{ n: number }>("SELECT count(*)::int n FROM owner_activity")).rows[0].n, 0);
  } finally {
    release?.(); await pending?.catch(() => {}); global.fetch = originalFetch;
    delete process.env.CHRONICLE_SECRET_KEYS; delete process.env.CHRONICLE_SECRET_ACTIVE_KEY; await f.close();
  }
});
