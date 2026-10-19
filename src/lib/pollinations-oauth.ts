import { createHash, randomBytes } from "node:crypto";
import { HttpError } from "./http";
import { openSecret, sealSecret, secretContext, type SecretKeyring } from "./secret-vault";

export const POLLINATIONS_OAUTH_COOKIE = "chronicle_pollinations_connect";
type Config = { clientId: string; redirectUri: string };
const invalid = () => new HttpError(400, "POLLINATIONS_CONNECT_INVALID", "Подключение Pollinations истекло или не подтверждено. Начните заново.");
export function pollinationsOAuthConfig(env: Record<string, string | undefined> = process.env): Config | null {
  const origin = env.CHRONICLE_PUBLIC_ORIGIN ? new URL(env.CHRONICLE_PUBLIC_ORIGIN) : null;
  if (origin && (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/")) throw invalid();
  const metadataOrigin = origin?.protocol === "https:" && origin.hostname.includes(".") && !/^(?:\d[\d.]*|localhost)$/.test(origin.hostname) && !origin.hostname.endsWith(".local") ? origin : null;
  const clientId = env.POLLINATIONS_APP_KEY || (metadataOrigin ? new URL("/api/settings/pollinations/client", metadataOrigin).href : "");
  const redirectValue = env.POLLINATIONS_REDIRECT_URI || (origin ? new URL("/api/settings/pollinations/callback", origin).href : "");
  if (!clientId || !redirectValue) return null;
  const redirect = new URL(redirectValue);
  if ((!/^pk_[A-Za-z0-9_-]{4,200}$/.test(clientId) && clientId !== (metadataOrigin ? new URL("/api/settings/pollinations/client", metadataOrigin).href : "")) || redirect.username || redirect.password || redirect.search || redirect.hash
    || redirect.pathname !== "/api/settings/pollinations/callback" || (origin && redirect.origin !== origin.origin)
    || (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && ["localhost", "127.0.0.1"].includes(redirect.hostname)))) throw invalid();
  return { clientId, redirectUri: redirect.href };
}
/** AbortSignal alone cannot bound an adapter that ignores cancellation. */
async function withinDeadline<T>(milliseconds: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(milliseconds);
  let aborted!: () => void;
  const deadline = new Promise<never>((_, reject) => { aborted = () => reject(invalid()); signal.addEventListener("abort", aborted, { once: true }); });
  try {
    if (signal.aborted) throw invalid();
    return await Promise.race([deadline, run(signal)]);
  } finally { signal.removeEventListener("abort", aborted); }
}
async function json(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (signal.aborted || !response.ok || !response.body) { void response.body?.cancel().catch(() => {}); throw invalid(); }
  const reader = response.body.getReader(); let size = 0, text = ""; const decoder = new TextDecoder();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw invalid();
      const part = await reader.read();
      if (signal.aborted) throw invalid();
      if (part.done) break;
      size += part.value.byteLength; if (size > 16384) throw invalid();
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } finally { signal.removeEventListener("abort", cancel); cancel(); reader.releaseLock(); }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
async function discovery(fetchImpl: typeof fetch, signal: AbortSignal) {
  const data = await json(await fetchImpl("https://enter.pollinations.ai/.well-known/oauth-authorization-server", { redirect: "error", signal, cache: "no-store" }), signal);
  const endpoint = (key: string) => {
    if (typeof data[key] !== "string") throw invalid();
    const url = new URL(data[key]);
    if (url.origin !== "https://enter.pollinations.ai" || url.username || url.password || url.hash) throw invalid();
    return url.href;
  };
  return { authorize: endpoint("authorization_endpoint"), token: endpoint("token_endpoint") };
}
export async function beginPollinationsConnect(owner: string, cfg: Config, fetchImpl = fetch, keyring?: SecretKeyring, now = Date.now()) {
  const endpoints = await withinDeadline(8000, signal => discovery(fetchImpl, signal));
  const verifier = randomBytes(32).toString("base64url"), state = randomBytes(24).toString("base64url");
  const url = new URL(endpoints.authorize);
  url.search = new URLSearchParams({ response_type: "code", client_id: cfg.clientId, redirect_uri: cfg.redirectUri,
    scope: "generate", models: "text,image", budget: "5", expiry: "7", state, code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url") }).toString();
  const cookie = sealSecret(JSON.stringify({ verifier, state, expires: now + 600000, redirectUri: cfg.redirectUri, clientId: cfg.clientId }), secretContext(owner, "pollinations-oauth"), keyring);
  return { url: url.href, cookie };
}
export async function finishPollinationsConnect(owner: string, cfg: Config, cookie: string, state: string, code: string, fetchImpl = fetch, keyring?: SecretKeyring, now = Date.now()) {
  if (!cookie || cookie.length > 4096 || !state || state.length > 128 || !code || code.length > 2048) throw invalid();
  const saved = JSON.parse(openSecret(cookie, secretContext(owner, "pollinations-oauth"), { keyring, allowPlaintext: false }));
  if (saved.state !== state || !Number.isSafeInteger(saved.expires) || saved.expires <= now || saved.expires > now + 600000
    || saved.redirectUri !== cfg.redirectUri || saved.clientId !== cfg.clientId || typeof saved.verifier !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(saved.verifier)) throw invalid();
  const data = await withinDeadline(10000, async signal => {
    const endpoints = await discovery(fetchImpl, signal);
    return json(await fetchImpl(endpoints.token, { method: "POST", redirect: "error", signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: cfg.clientId, redirect_uri: cfg.redirectUri, code_verifier: saved.verifier }) }), signal);
  });
  if (typeof data.access_token !== "string" || !/^sk_[A-Za-z0-9_-]{4,1024}$/.test(data.access_token)
    || typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer"
    || (data.expires_in !== undefined && (!Number.isSafeInteger(data.expires_in) || Number(data.expires_in) <= 0 || Number(data.expires_in) > 366 * 86400))) throw invalid();
  return { key: data.access_token, ...(data.expires_in !== undefined ? { expiresAt: new Date(now + Number(data.expires_in) * 1000) } : {}) };
}
