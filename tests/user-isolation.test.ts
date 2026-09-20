import { test } from "node:test";
import assert from "node:assert/strict";

test("guest credentials are random, stable and cannot be replaced with the public profile id", async () => {
  const { newGuestToken, profileIdFromToken } = await import("../src/lib/guest-identity");
  const a = newGuestToken(), b = newGuestToken();
  assert.notEqual(a, b);
  const id = profileIdFromToken(a);
  assert.ok(id);
  assert.equal(profileIdFromToken(a), id);
  assert.notEqual(profileIdFromToken(b), id);
  assert.notEqual(profileIdFromToken(id), id);
  for (const bad of [undefined, "", "global", "local", "x".repeat(43), a + "x"]) assert.equal(profileIdFromToken(bad), null);
});

test("campaign policy isolates private and legacy campaigns and makes publication read-only", async () => {
  const { canAccessCampaign } = await import("../src/lib/campaign-policy");
  for (const visibility of ["private", "public"] as const) {
    const campaign = { ownerId: "alice", visibility };
    assert.equal(canAccessCampaign(campaign, "alice", "owner"), true);
    assert.equal(canAccessCampaign(campaign, "bob", "owner"), false);
    assert.equal(canAccessCampaign(campaign, "bob", "read"), visibility === "public");
  }
  assert.equal(canAccessCampaign({ ownerId: null, visibility: "private" }, "alice", "read"), false);
  assert.equal(canAccessCampaign({ ownerId: null, visibility: "public" }, "alice", "read"), false);
});
