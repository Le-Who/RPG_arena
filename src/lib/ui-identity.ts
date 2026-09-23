export type IdentityView = {
  kind: "guest" | "account";
  profileId: string;
  account: { id: string; login: string; profileId: string } | null;
  guestProfileId: string | null;
  isAdmin: boolean;
  capabilities: { administration: boolean };
  pendingGuestCampaigns: number;
  passwordRecoveryAvailable: boolean;
};

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Project only the public identity contract; incomplete responses cannot replace the active UI profile. */
export function parseIdentityResponse(value: unknown): IdentityView {
  const invalid = () => new Error("Не удалось определить профиль. Обновите страницу.");
  if (!record(value) || value.ok !== true || !record(value.identity)) throw invalid();
  const identity = value.identity;
  if (!["guest", "account"].includes(String(identity.kind)) || !text(identity.profileId)
    || typeof identity.isAdmin !== "boolean" || !record(identity.capabilities)
    || identity.capabilities.administration !== identity.isAdmin
    || typeof identity.pendingGuestCampaigns !== "number" || !Number.isSafeInteger(identity.pendingGuestCampaigns) || identity.pendingGuestCampaigns < 0
    || typeof identity.passwordRecoveryAvailable !== "boolean"
    || (identity.guestProfileId !== null && !text(identity.guestProfileId))) throw invalid();
  let account: IdentityView["account"] = null;
  if (identity.kind === "account") {
    const row = identity.account;
    if (!record(row) || !text(row.id) || !text(row.login) || row.profileId !== identity.profileId) throw invalid();
    account = { id: row.id, login: row.login, profileId: identity.profileId };
  } else if (identity.account !== null || identity.isAdmin || identity.guestProfileId !== identity.profileId) throw invalid();
  return {
    kind: identity.kind as IdentityView["kind"], profileId: identity.profileId, account,
    guestProfileId: identity.guestProfileId as string | null, isAdmin: identity.isAdmin,
    capabilities: { administration: identity.isAdmin }, pendingGuestCampaigns: identity.pendingGuestCampaigns,
    passwordRecoveryAvailable: identity.passwordRecoveryAvailable,
  };
}

export function canSeeAdministration(identity: IdentityView | null): boolean {
  return identity?.kind === "account" && identity.account !== null && identity.capabilities.administration;
}

/** Guest registration retains profile-bound drafts; a different profile must clear private UI data. */
export function profileChanged(previous: IdentityView | null, next: IdentityView): boolean {
  return previous !== null && previous.profileId !== next.profileId;
}

export function profileStorageKey(identity: Pick<IdentityView, "profileId">, purpose: string): string {
  return `chronicle:profile:${encodeURIComponent(identity.profileId)}:${purpose}`;
}

export function createWorkspaceLoadGate() {
  let generation = 0;
  return {
    begin: () => ++generation,
    isCurrent: (ticket: number) => ticket === generation,
    invalidate: () => { generation++; },
  };
}
