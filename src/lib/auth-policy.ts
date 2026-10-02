import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { HttpError } from "./http";

export const SESSION_COOKIE = "chronicle_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const SCRYPT_PREFIX = "scrypt:v1:32768:8:1";
const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 64, SCRYPT_OPTIONS, (error, key) => error ? reject(error) : resolve(key));
});
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export const newSessionToken = () => randomBytes(32).toString("hex");
export const validSessionToken = (token?: string): token is string => !!token && /^[a-f0-9]{64}$/.test(token);
export function normalizeLogin(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{2,39}$/.test(value.trim())) throw new HttpError(400, "INVALID_INPUT", "Логин: от 3 до 40 латинских букв, цифр, точки, дефиса или подчёркивания.");
  return value.trim().toLowerCase();
}
export function validatePassword(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 12 || Buffer.byteLength(value) > 256) throw new HttpError(400, "INVALID_INPUT", "Пароль: от 12 символов до 256 байт.");
}
export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(16).toString("hex");
  return `${SCRYPT_PREFIX}:${salt}:${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password: unknown, encoded?: string): Promise<boolean> {
  if (typeof password !== "string" || Buffer.byteLength(password) > 256) return false;
  const parts = encoded?.split(":");
  // Never execute work factors supplied by a stored string: only this exact version is supported.
  const valid = parts?.length === 7 && parts.slice(0, 5).join(":") === SCRYPT_PREFIX && /^[a-f0-9]{32}$/.test(parts[5]) && /^[a-f0-9]{128}$/.test(parts[6]);
  // Missing accounts take the same expensive derivation as existing accounts.
  const result = await derive(password, valid ? parts![5] : "0".repeat(32));
  return !!valid && timingSafeEqual(result, Buffer.from(parts![6], "hex"));
}
export function isAdminAccount(id: string | null | undefined, allowlist = process.env.CHRONICLE_ADMIN_ACCOUNT_IDS ?? ""): boolean {
  return !!id && allowlist.split(",").map(x => x.trim()).filter(Boolean).includes(id);
}
export function assertAuthOrigin(request: Request): void {
  const allowed = process.env.CHRONICLE_PUBLIC_ORIGIN || new URL(request.url).origin;
  if (request.headers.get("origin") !== allowed || request.headers.get("sec-fetch-site") === "cross-site") throw new HttpError(403, "ORIGIN_REJECTED", "ORIGIN_REJECTED");
}
/** Proxy headers are ignored unless the operator names one sanitized, overwritten ingress header. */
export function authRateLimitClient(request: Request): string {
  const header = process.env.CHRONICLE_AUTH_TRUSTED_CLIENT_HEADER;
  const value = header ? request.headers.get(header)?.trim() : undefined;
  return value && value.length <= 128 ? tokenHash(value) : "untrusted-global";
}
