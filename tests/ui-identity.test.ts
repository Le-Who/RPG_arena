import test from "node:test";
import assert from "node:assert/strict";
import { canSeeAdministration, createWorkspaceLoadGate, parseIdentityResponse, profileStorageKey, profileChanged } from "../src/lib/ui-identity";

const guest = { kind: "guest", profileId: "guest:a", account: null, guestProfileId: "guest:a", isAdmin: false, pendingGuestCampaigns: 0, capabilities: { administration: false }, passwordRecoveryAvailable: false };
const account = { ...guest, kind: "account", account: { id: "account-a", login: "alice", profileId: "guest:a" } };

test("administrative navigation defaults closed for loading, guests and ordinary accounts", () => {
  assert.equal(canSeeAdministration(null), false);
  assert.equal(canSeeAdministration(parseIdentityResponse({ ok: true, identity: guest })), false);
  assert.equal(canSeeAdministration(parseIdentityResponse({ ok: true, identity: account })), false);
  assert.equal(canSeeAdministration(parseIdentityResponse({ ok: true, identity: { ...account, isAdmin: true, capabilities: { administration: true } } })), true);
});

test("partial or inconsistent identity responses never become an authenticated UI state", () => {
  for (const value of [{}, { ok: false, identity: guest }, { ok: true, identity: { ...account, account: null } }, { ok: true, identity: { ...guest, isAdmin: true, capabilities: { administration: true } } }, { ok: true, identity: { ...account, account: { ...account.account, profileId: "other" } } }, { ok: true, identity: { ...guest, pendingGuestCampaigns: -1 } }]) {
    assert.throws(() => parseIdentityResponse(value), /профил/i);
  }
});

test("registration preserving the profile keeps drafts; login/logout changing profile resets scoped data", () => {
  const before = parseIdentityResponse({ ok: true, identity: guest });
  const registered = parseIdentityResponse({ ok: true, identity: account });
  assert.equal(profileChanged(before, registered), false);
  assert.equal(profileChanged(registered, parseIdentityResponse({ ok: true, identity: { ...guest, profileId: "guest:b", guestProfileId: "guest:b" } })), true);
  assert.equal(profileChanged(null, before), false);
  assert.notEqual(profileStorageKey(before, "recent-commands"), profileStorageKey({ ...before, profileId: "guest:b" }, "recent-commands"));
});

test("a later refresh or identity change invalidates old workspace results", () => {
  const gate = createWorkspaceLoadGate();
  const old = gate.begin();
  const current = gate.begin();
  assert.equal(gate.isCurrent(old), false);
  assert.equal(gate.isCurrent(current), true);
  gate.invalidate();
  assert.equal(gate.isCurrent(current), false);
  assert.equal(gate.isCurrent(gate.begin()), true);
});
