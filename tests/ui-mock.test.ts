import test from "node:test";
import assert from "node:assert/strict";
import type { Page, Route } from "@playwright/test";
import { installUiMock, mockSessionId } from "../scripts/ui-mock";

async function requestFixture(path: string, method = "GET") {
  let handle!: (route: Route) => Promise<void>;
  const page = {
    route: async (_pattern: string, handler: typeof handle) => { handle = handler; },
  } as unknown as Page;
  await installUiMock(page);
  let response!: { status: number; contentType?: string; body: string };
  await handle({
    request: () => ({ url: () => `https://fixture.test${path}`, method: () => method }),
    fulfill: async (options: typeof response) => { response = options; },
  } as unknown as Route);
  return { status: response.status, body: JSON.parse(response.body) };
}

test("the UI fixture fails an unconfigured endpoint instead of claiming HTTP success", async () => {
  const response = await requestFixture("/api/unconfigured-feature");
  assert.equal(response.status, 501);
  assert.equal(response.body.code, "UI_MOCK_UNHANDLED");
});

test("read-only UI fixtures cannot claim that an unconfigured mutation was saved", async () => {
  for (const [path, method] of [["/api/settings", "POST"], ["/api/workspace", "PATCH"], [`/api/sessions/${mockSessionId}`, "DELETE"]]) {
    const response = await requestFixture(path, method);
    assert.equal(response.status, 501, `${method} ${path}`);
    assert.equal(response.body.code, "UI_MOCK_UNHANDLED");
  }
});

test("configured UI reads return the expected synthetic identity and campaign", async () => {
  const identity = await requestFixture("/api/auth/me");
  assert.equal(identity.status, 200);
  assert.equal(identity.body.identity.kind, "guest");
  assert.equal(identity.body.identity.profileId, "guest:ui-audit-fixture");
  const snapshot = await requestFixture(`/api/sessions/${mockSessionId}?memories=8`);
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body.session.id, "00000000-0000-4000-8000-000000000001");
  assert.equal(snapshot.body.session.character.name, "Элиан");
});
