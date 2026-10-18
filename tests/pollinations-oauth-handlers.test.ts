import "./helpers/test-environment";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { accountsDb } from "./helpers/accounts-db";
import { openSecret, secretContext } from "../src/lib/secret-vault";
import { profileIdFromToken } from "../src/lib/guest-identity";
import { POLLINATIONS_OAUTH_COOKIE } from "../src/lib/pollinations-oauth";

const base = "https://oauth.fixture.test", callback = `${base}/api/settings/pollinations/callback`;
const metadata = { authorization_endpoint: "https://enter.pollinations.ai/authorize", token_endpoint: "https://enter.pollinations.ai/api/oauth/token" };
async function invoke(request: Request, run: () => Promise<Response>) {
  // Use Next's actual request/action cookie storage and response serialization.
  // This boundary does not claim real server dispatch or browser cookie storage.
  const { createRequestStore } = await import("next/dist/server/async-storage/request-store");
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external");
  const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external");
  const { appendMutableCookies } = await import("next/dist/server/web/spec-extension/adapters/request-cookies");
  const store = createRequestStore({ phase: "action", headers: request.headers, url: new URL(request.url), rootParams: {}, implicitTags: { tags: [], expirationsByCacheKind: new Map() }, resumeDataCache: null,
    onUpdateCookies: undefined, previewProps: undefined, isHmrRefresh: false, serverComponentsHmrCache: undefined, hmrRefreshHash: undefined, stagedFallbackParams: null });
  const response = await workAsyncStorage.run({ route: "/api/settings/pollinations", isStaticGeneration: false } as never, () => workUnitAsyncStorage.run(store, run));
  appendMutableCookies(response.headers, store.mutableCookies);
  return response;
}
async function fixture() {
  const database = await accountsDb();
  const saved = Object.fromEntries(["POLLINATIONS_APP_KEY", "POLLINATIONS_REDIRECT_URI", "CHRONICLE_SECRET_ACTIVE_KEY", "CHRONICLE_SECRET_KEYS"].map(key => [key, process.env[key]]));
  process.env.POLLINATIONS_APP_KEY = "pk_fixture_app";
  process.env.POLLINATIONS_REDIRECT_URI = callback;
  process.env.CHRONICLE_SECRET_ACTIVE_KEY = "oauth-test";
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify({ "oauth-test": Buffer.alloc(32, 41).toString("base64") });
  const connect = await import("../src/app/api/settings/pollinations/connect/route");
  const completion = await import("../src/app/api/settings/pollinations/callback/route");
  const start = async (identity: string) => {
    const request = new Request(`${base}/api/settings/pollinations/connect`, { method: "POST", headers: { cookie: identity } });
    const response = await invoke(request, () => connect.POST());
    assert.equal(response.status, 200, await response.clone().text());
    const authUrl = new URL((await response.json()).url);
    const cookie = response.headers.getSetCookie().find(x => x.startsWith(`${POLLINATIONS_OAUTH_COOKIE}=`))!;
    assert.ok(cookie);
    return { authUrl, cookie, pair: cookie.split(";")[0] };
  };
  const finish = (identity: string, stateCookie: string, query: string) => {
    const request = new Request(`${callback}?${query}`, { headers: { cookie: `${identity}; ${stateCookie}` } });
    return invoke(request, () => completion.GET(request));
  };
  return { ...database, start, finish, async close() {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await database.close();
  } };
}
function assertCleared(response: Response) {
  const cleared = response.headers.getSetCookie().find(x => x.startsWith(`${POLLINATIONS_OAUTH_COOKIE}=`))!;
  assert.match(cleared, /chronicle_pollinations_connect=;/);
  assert.match(cleared, /Path=\/api\/settings\/pollinations/);
  assert.match(cleared, /Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
}

test("actual OAuth handlers issue scoped private cookies, correct PKCE and clear successful/replayed callback state", async () => {
  const f = await fixture(), guest = "e".repeat(64), identity = `chronicle_guest=${guest}`, owner = profileIdFromToken(guest)!;
  let verifier = "", exchanges = 0;
  const fetch = mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/.well-known/oauth-authorization-server")) return Response.json(metadata);
    assert.equal(String(url), metadata.token_endpoint);
    exchanges++;
    const body = new URLSearchParams(String(init?.body));
    verifier = body.get("code_verifier")!;
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("client_id"), "pk_fixture_app");
    assert.equal(body.get("redirect_uri"), callback);
    return Response.json({ access_token: "sk_synthetic_fixture_token", token_type: "bearer", expires_in: 600 });
  });
  try {
    const started = await f.start(identity);
    assert.match(started.cookie, /HttpOnly/); assert.match(started.cookie, /Secure/); assert.match(started.cookie, /SameSite=Lax/i);
    assert.match(started.cookie, /Path=\/api\/settings\/pollinations/); assert.match(started.cookie, /Max-Age=600/);
    const state = started.authUrl.searchParams.get("state")!;
    const response = await f.finish(identity, started.pair, `state=${state}&code=synthetic-code`);
    assert.equal(response.status, 303); assertCleared(response);
    assert.equal(response.headers.get("location"), `${base}/settings?pollinations=connected`);
    assert.equal(started.authUrl.searchParams.get("code_challenge"), createHash("sha256").update(verifier).digest("base64url"));
    const settings = (await f.pg.query<{ pollinations_key: string; text_provider: string; use_live_ai: boolean }>("SELECT pollinations_key,text_provider,use_live_ai FROM ai_settings WHERE id=$1", [owner])).rows[0];
    assert.equal(openSecret(settings.pollinations_key, secretContext(owner, "text:pollinations"), { allowPlaintext: false }), "sk_synthetic_fixture_token");
    assert.equal(settings.text_provider, "gemini");
    const snapshot = (await f.pg.query("SELECT * FROM ai_settings WHERE id=$1", [owner])).rows;
    const replay = await f.finish(identity, "", `state=${state}&code=synthetic-code`);
    assert.equal(replay.status, 400); assertCleared(replay);
    assert.equal(exchanges, 1);
    assert.deepEqual((await f.pg.query("SELECT * FROM ai_settings WHERE id=$1", [owner])).rows, snapshot);
  } finally { fetch.mock.restore(); await f.close(); }
});

for (const failure of ["state", "declined", "token-error"] as const) test(`actual OAuth ${failure} callback clears state without attaching credentials`, async () => {
  const f = await fixture(), guest = "f".repeat(64), identity = `chronicle_guest=${guest}`;
  let exchanges = 0;
  const fetch = mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    if (String(url).endsWith("/.well-known/oauth-authorization-server")) return Response.json(metadata);
    exchanges++; return Response.json({ error: "fixture-only-secret-must-not-leak" }, { status: 400 });
  });
  try {
    const started = await f.start(identity), state = started.authUrl.searchParams.get("state")!;
    const response = await f.finish(identity, started.pair, failure === "declined" ? "error=access_denied" : `state=${failure === "state" ? "wrong" : state}&code=synthetic-code`);
    assert.equal(response.status, 400); assertCleared(response);
    assert.equal(exchanges, failure === "token-error" ? 1 : 0);
    assert.equal((await f.pg.query<{ n: number }>("SELECT count(*)::int n FROM ai_settings")).rows[0].n, 0);
    assert.ok(!(await response.text()).includes("fixture-only-secret"));
    assert.equal((await f.pg.query<{ n: number }>("SELECT count(*)::int n FROM owner_activity")).rows[0].n, 0);
  } finally { fetch.mock.restore(); await f.close(); }
});

test("revocation during token response cannot attach OAuth credentials to the admitted account or guest", async () => {
  const f = await fixture();
  const { auth } = await import("../src/lib/auth");
  const account = await auth.register("a".repeat(64), "oauthrace", "correct horse battery staple");
  const identity = `chronicle_guest=${account.guestToken}; chronicle_session=${account.sessionToken}`;
  let entered!: () => void, release!: () => void;
  const tokenEntered = new Promise<void>(resolve => { entered = resolve; }), tokenRelease = new Promise<void>(resolve => { release = resolve; });
  const fetch = mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    if (String(url).endsWith("/.well-known/oauth-authorization-server")) return Response.json(metadata);
    entered(); await tokenRelease;
    return Response.json({ access_token: "sk_synthetic_race_token", token_type: "bearer", expires_in: 600 });
  });
  let pending: Promise<Response> | undefined;
  try {
    const started = await f.start(identity), state = started.authUrl.searchParams.get("state")!;
    pending = f.finish(identity, started.pair, `state=${state}&code=synthetic-code`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([tokenEntered, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Timed out: OAuth token response entered")), 8000); })]); }
    finally { clearTimeout(timer); }
    await auth.logout(account.sessionToken);
    release();
    const response = await pending;
    assert.equal((await f.pg.query<{ n: number }>("SELECT count(*)::int n FROM ai_settings")).rows[0].n, 0, "late token response cannot write either identity's key");
    assert.equal(response.status, 400); assertCleared(response);
    assert.equal((await f.pg.query<{ n: number }>("SELECT count(*)::int n FROM owner_activity")).rows[0].n, 0);
  } finally { release(); await pending?.catch(() => {}); fetch.mock.restore(); await f.close(); }
});
