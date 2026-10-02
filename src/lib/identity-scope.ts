import { AsyncLocalStorage } from "node:async_hooks";
import type { Identity } from "./auth";
import { HttpError } from "./http";

type Principal = { kind: Identity["kind"]; profileId: string; accountId: string | null };
const admittedPrincipal = new AsyncLocalStorage<Principal>();

/** A consistency fence only: identity/session/role resolution still reads fresh state.
 * Revocation must not turn a request admitted for an account into a guest write. */
export function assertAdmittedIdentity(identity: Identity): void {
  const admitted = admittedPrincipal.getStore();
  if (admitted && (identity.kind !== admitted.kind || identity.profileId !== admitted.profileId || (identity.account?.id ?? null) !== admitted.accountId)) {
    throw new HttpError(401, "IDENTITY_CHANGED", "Профиль изменился. Обновите страницу.");
  }
}

export function withAdmittedIdentity<T>(identity: Identity, run: () => Promise<T>): Promise<T> {
  assertAdmittedIdentity(identity);
  return admittedPrincipal.run({ kind: identity.kind, profileId: identity.profileId, accountId: identity.account?.id ?? null }, run);
}
