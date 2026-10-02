import test from "node:test";
import assert from "node:assert/strict";
import { withServerTiming } from "../src/lib/owner-work";

test("server timing preserves response and existing metrics without consuming streaming bodies", async () => {
  const response = new Response("body", { status: 201, headers: { "Server-Timing": "db;dur=2", "x-test": "yes" } });
  assert.equal(withServerTiming(response, performance.now() - 10), response);
  assert.match(response.headers.get("Server-Timing")!, /^db;dur=2, app;desc="response-ready";dur=\d+\.\d$/);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-test"), "yes");
  assert.equal(response.bodyUsed, false);
  assert.equal(await response.text(), "body");
  const immutable = Response.redirect("https://example.test/");
  assert.equal(withServerTiming(immutable, performance.now()), immutable);
});
