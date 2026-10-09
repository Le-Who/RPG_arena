import { test } from "node:test";
import assert from "node:assert/strict";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import nextConfig from "../next.config";

async function configuredHeaders(url: string): Promise<Headers> {
  const pathname = new URL(url, "https://chronicle.test").pathname;
  const headers = new Headers();
  const config = nextConfig(PHASE_PRODUCTION_BUILD);
  for (const rule of await config.headers?.() ?? []) {
    if (getPathMatch(rule.source)(pathname)) {
      for (const header of rule.headers) headers.set(header.key, header.value);
    }
  }
  return headers;
}

test("application, API and public assets receive the global security policy", async () => {
  for (const path of ["/", "/play/story", "/api/version", "/offline.html", "/_next/static/chunks/app.js"]) {
    const headers = await configuredHeaders(path);
    assert.equal(headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(headers.get("x-frame-options"), "DENY", path);
    assert.equal(headers.get("referrer-policy"), "strict-origin-when-cross-origin", path);
  }
});

test("OAuth callback success and error URLs retain the stronger referrer policy", async () => {
  for (const path of [
    "/api/settings/pollinations/callback?code=synthetic-code&state=synthetic-state",
    "/api/settings/pollinations/callback?error=access_denied",
  ]) {
    const headers = await configuredHeaders(path);
    assert.equal(headers.get("referrer-policy"), "no-referrer", path);
    assert.equal(headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(headers.get("x-frame-options"), "DENY", path);
  }
});

test("service worker retains its script MIME type and uncached update policy", async () => {
  const headers = await configuredHeaders("/sw.js");
  assert.equal(headers.get("content-type"), "application/javascript; charset=utf-8");
  assert.equal(headers.get("cache-control"), "no-cache, no-store, must-revalidate");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
});
