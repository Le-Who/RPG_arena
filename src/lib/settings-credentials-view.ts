import { HttpError } from "./http";
import { openSecret, secretContext } from "./secret-vault";

export type CredentialProvider = "gemini" | "openrouter" | "pollinations";
type StoredCredentials = { id: string; keys: string[] | null; openrouterKey: string; pollinationsKey: string };
const recoverableErrors = new Set(["SECRET_MIGRATION_REQUIRED", "SECRET_DECRYPTION_FAILED", "SECRET_STORAGE_UNAVAILABLE"]);

export function isCredentialReadError(error: unknown): error is HttpError {
  return error instanceof HttpError && recoverableErrors.has(error.code);
}

/** A credential problem belongs to its connection, never to loading the owner's workspace. */
export function settingsCredentialsView(row: StoredCredentials) {
  const issues = new Set<CredentialProvider>();
  function inspect(value: string, provider: CredentialProvider): string {
    try {
      const key = openSecret(value, secretContext(row.id, provider === "gemini" ? "gemini" : `text:${provider}`));
      return key.length <= 8 ? "••••" : `${key.slice(0, 4)}••••${key.slice(-4)}`;
    } catch (error) {
      if (!isCredentialReadError(error)) throw error;
      issues.add(provider);
      // Never show ciphertext fragments or legacy plaintext for an unreadable value.
      return "••••";
    }
  }
  const keysMasked = (row.keys ?? []).filter(Boolean).map(key => inspect(key, "gemini"));
  if (row.openrouterKey) inspect(row.openrouterKey, "openrouter");
  if (row.pollinationsKey) inspect(row.pollinationsKey, "pollinations");
  return { keysMasked, credentialIssues: [...issues] };
}
