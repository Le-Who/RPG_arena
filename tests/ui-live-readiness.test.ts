import test from "node:test";
import assert from "node:assert/strict";
import * as uiData from "../src/lib/ui-data";

test("server readiness permits an external narrator without direct Gemini keys", () => {
  assert.equal(typeof uiData.canUseLiveNarrator, "function");
  assert.equal(uiData.canUseLiveNarrator({ canUseLive: true, useLiveAI: true, keysCount: 0, envKeysCount: 0 }), true);
});

test("server rejection overrides enabled AI and available direct Gemini credentials", () => {
  assert.equal(uiData.canUseLiveNarrator({ canUseLive: false, useLiveAI: true, keysCount: 3, envKeysCount: 2 }), false);
});

test("legacy settings retain enabled direct Gemini readiness", () => {
  assert.equal(uiData.canUseLiveNarrator({ useLiveAI: true, keysCount: 0, envKeysCount: 1 }), true);
  assert.equal(uiData.canUseLiveNarrator({ useLiveAI: false, keysCount: 1, envKeysCount: 0 }), false);
  assert.equal(uiData.canUseLiveNarrator({ useLiveAI: true, keysCount: 0, envKeysCount: 0 }), false);
  assert.equal(uiData.canUseLiveNarrator(null), false);
});
