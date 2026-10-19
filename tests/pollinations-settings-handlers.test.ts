import test from "node:test";
import assert from "node:assert/strict";
import { accountsDb, cookieContext } from "./helpers/accounts-db";

test("visual preferences handlers reject ownership injection and persist only the admitted profile without exposing credentials", async () => {
  const f = await accountsDb();
  try {
    const { GET, POST } = await import("../src/app/api/settings/visual-provider/route");
    const owner = `chronicle_guest=${"a".repeat(64)}`, other = `chronicle_guest=${"b".repeat(64)}`;
    const write = (body: unknown) => cookieContext(owner, () => POST(new Request("https://fixture.test/api/settings/visual-provider", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })));
    for (const body of [{ accountSource: ["personal"], model: "vendor/image" }, { accountSource: "personal", model: "bad model" }, { accountSource: "personal", model: "vendor/image", ownerId: "other" }]) assert.equal((await write(body)).status, 400);
    const saved = await write({ accountSource: "personal", model: "vendor/image" });
    assert.equal(saved.status, 200); assert.equal(saved.headers.get("cache-control"), "private, no-store");
    const view = await (await cookieContext(owner, () => GET())).json();
    assert.equal(view.accountSource, "personal"); assert.equal(view.model, "vendor/image");
    assert.equal((await (await cookieContext(other, () => GET())).json()).accountSource, "application");
    for (const name of ["pollinationsKey", "apiKey", "keys"]) assert.equal(Object.hasOwn(view, name), false);
    assert.equal((await f.pg.query<{ n: number }>("SELECT count(*)::int n FROM owner_activity")).rows[0].n, 0);
  } finally { await f.close(); }
});

test("public native OAuth metadata contains only app identity and its configured redirect, without touching a database", async () => {
  const saved = { origin: process.env.CHRONICLE_PUBLIC_ORIGIN, app: process.env.POLLINATIONS_APP_KEY, callback: process.env.POLLINATIONS_REDIRECT_URI };
  try {
    process.env.CHRONICLE_PUBLIC_ORIGIN = "https://chronicle.fixture.test"; delete process.env.POLLINATIONS_APP_KEY; delete process.env.POLLINATIONS_REDIRECT_URI;
    const { GET } = await import("../src/app/api/settings/pollinations/client/route");
    const response = await GET();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { client_id: "https://chronicle.fixture.test/api/settings/pollinations/client", client_name: "Chronicle Engine", redirect_uris: ["https://chronicle.fixture.test/api/settings/pollinations/callback"], token_endpoint_auth_method: "none" });
    process.env.CHRONICLE_PUBLIC_ORIGIN = "http://localhost:3000";
    assert.equal((await GET()).status, 404);
  } finally {
    for (const [name, value] of [["CHRONICLE_PUBLIC_ORIGIN", saved.origin], ["POLLINATIONS_APP_KEY", saved.app], ["POLLINATIONS_REDIRECT_URI", saved.callback]]) if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
  }
});
