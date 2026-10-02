import { createHash, randomBytes } from "node:crypto";
import { HttpError } from "./http";
import { openSecret, sealSecret, secretContext, type SecretKeyring } from "./secret-vault";

export const POLLINATIONS_OAUTH_COOKIE = "chronicle_pollinations_connect";
type Config = { clientId: string; redirectUri: string };
const invalid = () => new HttpError(400, "POLLINATIONS_CONNECT_INVALID", "Подключение Pollinations истекло или не подтверждено. Начните заново.");
export function pollinationsOAuthConfig(env: Record<string, string | undefined> = process.env): Config | null {
  if (!env.POLLINATIONS_APP_KEY || !env.POLLINATIONS_REDIRECT_URI) return null;
  const clientId = env.POLLINATIONS_APP_KEY;
  const redirect = new URL(env.POLLINATIONS_REDIRECT_URI);
  if (!/^pk_[A-Za-z0-9_-]{4,200}$/.test(clientId) || redirect.username || redirect.password || redirect.search || redirect.hash
    || redirect.pathname !== "/api/settings/pollinations/callback"
    || (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && ["localhost", "127.0.0.1"].includes(redirect.hostname)))) throw invalid();
  return { clientId, redirectUri: redirect.href };
}
async function json(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok || !response.body) throw invalid();
  const reader = response.body.getReader(); let size = 0, text = ""; const decoder = new TextDecoder();
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > 16384) throw invalid();
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
async function discovery(fetchImpl: typeof fetch, signal: AbortSignal) {
  const data = await json(await fetchImpl("https://enter.pollinations.ai/.well-known/oauth-authorization-server", { redirect: "error", signal, cache: "no-store" }));
  const endpoint = (key: string) => {
    if (typeof data[key] !== "string") throw invalid();
    const url = new URL(data[key]);
    if (url.origin !== "https://enter.pollinations.ai" || url.username || url.password || url.hash) throw invalid();
    return url.href;
  };
  return { authorize: endpoint("authorization_endpoint"), token: endpoint("token_endpoint") };
}
export async function beginPollinationsConnect(owner: string, cfg: Config, fetchImpl = fetch, keyring?: SecretKeyring, now = Date.now()) {
  const endpoints = await discovery(fetchImpl, AbortSignal.timeout(8000));
  const verifier = randomBytes(32).toString("base64url"), state = randomBytes(24).toString("base64url");
  const url = new URL(endpoints.authorize);
  url.search = new URLSearchParams({ response_type: "code", client_id: cfg.clientId, redirect_uri: cfg.redirectUri,
    scope: "usage", budget: "5", expiry: "7", state, code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url") }).toString();
  const cookie = sealSecret(JSON.stringify({ verifier, state, expires: now + 600000, redirectUri: cfg.redirectUri, clientId: cfg.clientId }), secretContext(owner, "pollinations-oauth"), keyring);
  return { url: url.href, cookie };
}
export async function finishPollinationsConnect(owner: string, cfg: Config, cookie: string, state: string, code: string, fetchImpl = fetch, keyring?: SecretKeyring, now = Date.now()) {
  if (!cookie || cookie.length > 4096 || !state || state.length > 128 || !code || code.length > 2048) throw invalid();
  const saved = JSON.parse(openSecret(cookie, secretContext(owner, "pollinations-oauth"), { keyring, allowPlaintext: false }));
  if (saved.state !== state || !Number.isSafeInteger(saved.expires) || saved.expires <= now || saved.expires > now + 600000
    || saved.redirectUri !== cfg.redirectUri || saved.clientId !== cfg.clientId || typeof saved.verifier !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(saved.verifier)) throw invalid();
  const signal = AbortSignal.timeout(10000), endpoints = await discovery(fetchImpl, signal);
  const data = await json(await fetchImpl(endpoints.token, { method: "POST", redirect: "error", signal,
    headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: cfg.clientId, redirect_uri: cfg.redirectUri, code_verifier: saved.verifier }) }));
  if (typeof data.access_token !== "string" || !/^sk_[A-Za-z0-9_-]{4,1024}$/.test(data.access_token)
    || typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer"
    || !Number.isSafeInteger(data.expires_in) || Number(data.expires_in) <= 0 || Number(data.expires_in) > 366 * 86400) throw invalid();
  return { key: data.access_token, expiresAt: new Date(now + Number(data.expires_in) * 1000) };
}
