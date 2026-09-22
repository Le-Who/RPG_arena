import { randomBytes } from "node:crypto";
import type { SecretKeyring } from "../../src/lib/secret-vault";

/** Install a process-local keyring for disposable smoke fixtures only. */
export function installSyntheticSecretKeyring(keyId = "smoke-v1"): SecretKeyring {
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(keyId)) throw new Error("Invalid synthetic key identifier");
  const ring: SecretKeyring = { active: keyId, keys: { [keyId]: randomBytes(32).toString("base64") } };
  process.env.CHRONICLE_SECRET_ACTIVE_KEY = ring.active;
  process.env.CHRONICLE_SECRET_KEYS = JSON.stringify(ring.keys);
  delete process.env.CHRONICLE_ALLOW_LEGACY_PLAINTEXT;
  return ring;
}
