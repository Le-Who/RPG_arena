import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_READING, normalizeReading, readingAttributes, READING_OPTIONS } from "../src/lib/reading-preferences";

test("v2.5 reading: unknown, partial and hostile input always yield a renderable theme", () => {
  assert.deepEqual(normalizeReading(undefined), DEFAULT_READING);
  assert.deepEqual(normalizeReading(null), DEFAULT_READING);
  assert.deepEqual(normalizeReading("sepia"), DEFAULT_READING);
  assert.deepEqual(normalizeReading([{ theme: "sepia" }]), DEFAULT_READING);
  assert.deepEqual(normalizeReading({ theme: "neon", textScale: 12, measure: null }), DEFAULT_READING);
  assert.equal(normalizeReading({ theme: "sepia" }).theme, "sepia");
  assert.equal(normalizeReading({ theme: "sepia" }).measure, "normal", "unspecified keys fall back, never undefined");
  // Prototype pollution attempts must not leak into the result.
  const polluted = normalizeReading(JSON.parse('{"__proto__":{"theme":"neon"},"theme":"contrast"}'));
  assert.equal(polluted.theme, "contrast");
  assert.equal(Object.keys(polluted).length, 4);
});

test("v2.5 reading: every declared option round-trips and maps to data attributes", () => {
  for (const [key, options] of Object.entries(READING_OPTIONS)) {
    for (const option of options) {
      const result = normalizeReading({ [key]: option.value }) as Record<string, string>;
      assert.equal(result[key], option.value, `${key}=${option.value} must survive normalization`);
    }
  }
  assert.deepEqual(readingAttributes({ textScale: "large", measure: "wide", theme: "contrast", motion: "reduced" }), {
    "data-text": "large", "data-measure": "wide", "data-theme": "contrast", "data-motion": "reduced",
  });
});
