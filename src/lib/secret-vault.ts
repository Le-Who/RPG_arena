import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { HttpError } from "./http";

export type SecretKeyring = { active: string; keys: Record<string, string> };
export type SecretOpenOptions = { keyring?: SecretKeyring; allowPlaintext?: boolean };

const PREFIX = "enc:v1:";
const KEY_ID = /^[a-zA-Z0-9_-]{1,48}$/;
const BASE64_KEY = /^[A-Za-z0-9+/]{43}=$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function unavailable(): HttpError {
  return new HttpError(503, "SECRET_STORAGE_UNAVAILABLE", "Хранилище ключей не настроено. Администратору нужно задать CHRONICLE_SECRET_KEYS и CHRONICLE_SECRET_ACTIVE_KEY.");
}

function decryptionFailed(): HttpError {
  return new HttpError(503, "SECRET_DECRYPTION_FAILED", "Не удалось безопасно прочитать ключ. Проверьте версию ключа шифрования или сохраните API-ключ заново.");
}

function decodeKey(value: unknown): Buffer {
  if (typeof value !== "string" || !BASE64_KEY.test(value)) throw unavailable();
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) throw unavailable();
  return key;
}

function validateKeyring(ring: SecretKeyring): void {
  if (!ring || typeof ring !== "object" || !KEY_ID.test(ring.active) || !ring.keys || typeof ring.keys !== "object" || Array.isArray(ring.keys)) throw unavailable();
  const entries = Object.entries(ring.keys);
  if (entries.length === 0 || !Object.prototype.hasOwnProperty.call(ring.keys, ring.active)) throw unavailable();
  for (const [id, value] of entries) {
    if (!KEY_ID.test(id)) throw unavailable();
    decodeKey(value);
  }
}

function keyFor(ring: SecretKeyring, id: string): Buffer {
  validateKeyring(ring);
  if (!KEY_ID.test(id) || !Object.prototype.hasOwnProperty.call(ring.keys, id)) throw unavailable();
  return decodeKey(ring.keys[id]);
}

export function readSecretKeyring(): SecretKeyring {
  try {
    const parsed: unknown = JSON.parse(process.env.CHRONICLE_SECRET_KEYS ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw unavailable();
    const ring = { active: process.env.CHRONICLE_SECRET_ACTIVE_KEY ?? "", keys: parsed as Record<string, string> };
    keyFor(ring, ring.active);
    return ring;
  } catch {
    throw unavailable();
  }
}

export function secretStorageAvailable(): boolean {
  try {
    readSecretKeyring();
    return true;
  } catch {
    return false;
  }
}

export function secretContext(ownerId: string, purpose: string): string {
  return JSON.stringify(["chronicle-engine", 1, ownerId, purpose]);
}

export function isSealedSecret(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function secretNeedsRotation(value: string, active: string): boolean {
  if (!value) return false;
  if (!isSealedSecret(value)) return true;
  return value.split(":")[2] !== active;
}

/** AES-256-GCM with AAD binding each value to its owner and provider purpose. */
export function sealSecret(value: string, context: string, ring?: SecretKeyring): string {
  if (!value) return "";
  const keyring = ring ?? readSecretKeyring();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(keyring, keyring.active), iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(context));
  const payload = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${PREFIX}${keyring.active}:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${payload.toString("base64url")}`;
}

export function openSecret(value: string, context: string, options: SecretOpenOptions = {}): string {
  if (!value) return "";
  if (value.startsWith("enc:") && !value.startsWith(PREFIX)) throw decryptionFailed();
  if (!isSealedSecret(value)) {
    const allowed = options.allowPlaintext ?? process.env.CHRONICLE_ALLOW_LEGACY_PLAINTEXT === "true";
    if (allowed) return value;
    throw new HttpError(503, "SECRET_MIGRATION_REQUIRED", "Сохранённые ключи требуют защищённой миграции. Обратитесь к администратору.");
  }

  try {
    const parts = value.split(":");
    if (parts.length !== 6) throw new Error("format");
    const [, version, id, ivText, tagText, payloadText] = parts;
    if (version !== "v1" || !BASE64URL.test(ivText) || !BASE64URL.test(tagText) || !BASE64URL.test(payloadText)) throw new Error("format");
    const iv = Buffer.from(ivText, "base64url");
    const tag = Buffer.from(tagText, "base64url");
    const payload = Buffer.from(payloadText, "base64url");
    if (iv.length !== 12 || tag.length !== 16 || payload.length === 0) throw new Error("length");
    const ring = options.keyring ?? readSecretKeyring();
    const decipher = createDecipheriv("aes-256-gcm", keyFor(ring, id), iv, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8");
  } catch {
    throw decryptionFailed();
  }
}

type SecretSettings = {
  id: string;
  keys: string[] | null;
  typesafeKey: string;
  narrativeGuardKey: string;
  narrativeGuardProvider: string;
};

export function decodeGeminiSecrets<T extends Pick<SecretSettings, "id" | "keys">>(row: T, options: SecretOpenOptions = {}): T {
  return { ...row, keys: (row.keys ?? []).map(key => openSecret(key, secretContext(row.id, "gemini"), options)) };
}

export function decodeTypeSafeSecret<T extends Pick<SecretSettings, "id" | "typesafeKey">>(row: T, options: SecretOpenOptions = {}): T {
  return { ...row, typesafeKey: openSecret(row.typesafeKey ?? "", secretContext(row.id, "typesafe-pilot"), options) };
}

export function decodeNarrativeSecret<T extends Pick<SecretSettings, "id" | "narrativeGuardKey" | "narrativeGuardProvider">>(row: T, options: SecretOpenOptions = {}): T {
  return { ...row, narrativeGuardKey: openSecret(row.narrativeGuardKey ?? "", secretContext(row.id, `narrative:${row.narrativeGuardProvider}`), options) };
}

/** Decode only after a raw row has left the persistence boundary. */
export function decodeSettingsSecrets<T extends SecretSettings>(row: T, options: SecretOpenOptions = {}): T {
  return decodeNarrativeSecret(decodeTypeSafeSecret(decodeGeminiSecrets(row, options), options), options);
}
