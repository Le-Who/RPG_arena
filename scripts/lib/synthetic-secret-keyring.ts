import { randomBytes } from "node:crypto";
import { readSecretKeyring, type SecretKeyring } from "../../src/lib/secret-vault";

/** Install a process-local keyring for disposable smoke fixtures only. */
export function installSyntheticSecretKeyring(keyId = "smoke-v1"): SecretKeyring {
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(keyId)) throw new Error("Invalid synthetic key identifier");
  const ring: SecretKeyring = { active: keyId, keys: { [keyId]: randomBytes(32).toString("base64") } };
  process.env.CHRONICLE_SECRET_ACTIVE_KEY = ring.active;
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify(ring.keys);
  delete process.env.CHRONICLE_ALLOW_LEGACY_PLAINTEXT;
  return ring;
}

/** Read, but never replace, the keyring shared with a separately running isolated web server. */
export function requireSharedIsolatedSecretKeyring(): SecretKeyring {
  if (process.env.ARENA_ISOLATED_TEST_DB !== "1") throw new Error("Shared smoke keyring requires ARENA_ISOLATED_TEST_DB=1.");
  try {
    return readSecretKeyring();
  } catch {
    throw new Error("Shared smoke keyring is unavailable. Configure identical CHRONICLE_SECRET_ACTIVE_KEY and CHRONICLE_SECRET_KEYS for the isolated server and smoke process.");
  }
}

export async function assertMaskedSecretResponse(response: Response, forbiddenValue: string): Promise<unknown> {
  if (response.status !== 200) throw new Error(`Expected HTTP 200 from the isolated settings server; received ${response.status}.`);
  const body: unknown = await response.json();
  if (JSON.stringify(body).includes(forbiddenValue)) throw new Error("Settings response exposed a stored credential.");
  return body;
}
