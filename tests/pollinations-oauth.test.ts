import test from "node:test";
import assert from "node:assert/strict";
import { beginPollinationsConnect, finishPollinationsConnect, pollinationsOAuthConfig } from "../src/lib/pollinations-oauth";
const keyring = { active: "test", keys: { test: Buffer.alloc(32, 9).toString("base64") } };
const cfg = { clientId: "pk_test_app", redirectUri: "http://localhost:3000/api/settings/pollinations/callback" };
const metadata = { authorization_endpoint: "https://enter.pollinations.ai/authorize", token_endpoint: "https://enter.pollinations.ai/api/oauth/token" };
test("wallet connection binds consent to owner, state, expiry and PKCE", async () => {
  const fetcher = (async () => Response.json(metadata)) as typeof fetch;
  const started = await beginPollinationsConnect("owner-a", cfg, fetcher, keyring, 1000);
  const url = new URL(started.url);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope"), "generate", "generation does not need wallet balance, history or account administration permission");
  assert.equal(url.searchParams.get("budget"), "5");
  assert.equal(url.searchParams.get("models"), "text,image");
  let exchanges = 0;
  const exchange = (async (_url, init) => {
    if (!init?.method) return Response.json(metadata);
    exchanges++;
    assert.equal(new URLSearchParams(String(init.body)).get("client_id"), cfg.clientId);
    assert.ok(new URLSearchParams(String(init.body)).get("code_verifier"));
    return Response.json({ access_token: "sk_user_synthetic_secret", expires_in: 600, token_type: "bearer" });
  }) as typeof fetch;
  const state = url.searchParams.get("state")!;
  await assert.rejects(finishPollinationsConnect("owner-b", cfg, started.cookie, state, "code", exchange, keyring, 2000));
  await assert.rejects(finishPollinationsConnect("owner-a", cfg, started.cookie, "wrong", "code", exchange, keyring, 2000));
  await assert.rejects(finishPollinationsConnect("owner-a", cfg, started.cookie, state, "code", exchange, keyring, 601001));
  assert.equal(exchanges, 0);
  const token = await finishPollinationsConnect("owner-a", cfg, started.cookie, state, "code", exchange, keyring, 2000);
  assert.equal(token.key, "sk_user_synthetic_secret");
  assert.equal(token.expiresAt!.getTime(), 602000);
});

test("native consent can issue a key without an expiry; invalid supplied expiry is rejected", async () => {
  const started = await beginPollinationsConnect("owner-a", cfg, (async () => Response.json(metadata)) as typeof fetch, keyring);
  const state = new URL(started.url).searchParams.get("state")!;
  const token = (expiry: Record<string, unknown>) => (async (_url: unknown, init?: RequestInit) => Response.json(init?.method
    ? { access_token: "sk_synthetic_no_expiry", token_type: "bearer", ...expiry } : metadata)) as typeof fetch;
  assert.equal((await finishPollinationsConnect("owner-a", cfg, started.cookie, state, "code", token({}), keyring)).expiresAt, undefined);
  for (const expires_in of [null, -1, 0, "600", 0.5]) await assert.rejects(finishPollinationsConnect("owner-a", cfg, started.cookie, state, "code", token({ expires_in }), keyring));
});
test("OAuth rejects untrusted discovery endpoints and invalid configuration", async () => {
  assert.equal(pollinationsOAuthConfig({}), null);
  assert.throws(() => pollinationsOAuthConfig({ POLLINATIONS_APP_KEY: "sk_secret", POLLINATIONS_REDIRECT_URI: cfg.redirectUri }));
  await assert.rejects(beginPollinationsConnect("a", cfg, (async () => Response.json({ ...metadata, token_endpoint: "https://other.example/token" })) as typeof fetch, keyring));
});

test("public deployment supports Pollinations native client metadata without a registered app key", () => {
  assert.deepEqual(pollinationsOAuthConfig({ CHRONICLE_PUBLIC_ORIGIN: "https://chronicle.example" }), {
    clientId: "https://chronicle.example/api/settings/pollinations/client", redirectUri: "https://chronicle.example/api/settings/pollinations/callback",
  });
  assert.equal(pollinationsOAuthConfig({ CHRONICLE_PUBLIC_ORIGIN: "http://localhost:3000" }), null);
});

test("OAuth callback must share the configured public origin so the host-only state cookie returns", () => {
  assert.throws(() => pollinationsOAuthConfig({ CHRONICLE_PUBLIC_ORIGIN: "https://chronicle.example", POLLINATIONS_REDIRECT_URI: "https://other.example/api/settings/pollinations/callback" }));
  assert.throws(() => pollinationsOAuthConfig({ CHRONICLE_PUBLIC_ORIGIN: "https://chronicle.example", POLLINATIONS_APP_KEY: "pk_test_app", POLLINATIONS_REDIRECT_URI: "https://other.example/api/settings/pollinations/callback" }));
});
