import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { READING_CACHE_KEY, readingBootstrapScript } from "../src/lib/reading-preferences";

function bootstrap(stored: string | null, throws = false) {
  const attributes = new Map<string, string>();
  runInNewContext(readingBootstrapScript(), {
    localStorage: { getItem: (key: string) => {
      assert.equal(key, READING_CACHE_KEY);
      if (throws) throw new Error("Storage unavailable");
      return stored;
    } },
    document: { documentElement: { setAttribute: (name: string, value: string) => attributes.set(name, value) } },
  });
  return attributes;
}

test("cached reading preferences are applied before the workspace request", () => {
  const attrs = bootstrap(JSON.stringify({ textScale: "large", measure: "wide", theme: "sepia", motion: "reduced" }));
  assert.deepEqual(Object.fromEntries(attrs), { "data-text": "large", "data-measure": "wide", "data-theme": "sepia", "data-motion": "reduced" });
});

test("invalid or unavailable browser cache cannot set untrusted attributes", () => {
  assert.equal(bootstrap(JSON.stringify({ textScale: "large", measure: "wide", theme: "javascript:alert(1)", motion: "reduced" })).size, 0);
  assert.equal(bootstrap("not-json").size, 0);
  assert.equal(bootstrap(null, true).size, 0);
});
