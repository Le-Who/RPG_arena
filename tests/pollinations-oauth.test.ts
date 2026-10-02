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
  assert.equal(url.searchParams.get("scope"), "usage");
  assert.equal(url.searchParams.get("budget"), "5");
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
  assert.equal(token.expiresAt.getTime(), 602000);
});
test("OAuth rejects untrusted discovery endpoints and invalid configuration", async () => {
  assert.equal(pollinationsOAuthConfig({}), null);
  assert.throws(() => pollinationsOAuthConfig({ POLLINATIONS_APP_KEY: "sk_secret", POLLINATIONS_REDIRECT_URI: cfg.redirectUri }));
  await assert.rejects(beginPollinationsConnect("a", cfg, (async () => Response.json({ ...metadata, token_endpoint: "https://other.example/token" })) as typeof fetch, keyring));
});
