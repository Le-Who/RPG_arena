import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/lib/api-client";

test("API client preserves Headers and tuple header inputs accepted by RequestInit", async t => {
  const observed: Headers[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    observed.push(new Headers(init.headers));
    return Response.json({ ok: true });
  });
  await api("/fixture", { headers: new Headers({ "X-Request-ID": "headers-request", "Content-Type": "application/problem+json" }) });
  await api("/fixture", { headers: [["X-Request-ID", "tuple-request"]] });
  assert.equal(observed[0].get("X-Request-ID"), "headers-request");
  assert.equal(observed[0].get("Content-Type"), "application/problem+json");
  assert.equal(observed[1].get("X-Request-ID"), "tuple-request");
  assert.equal(observed[1].get("Content-Type"), "application/json");
});
