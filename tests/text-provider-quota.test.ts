import test from "node:test";
import assert from "node:assert/strict";
import { quotaCap, quotaModelId } from "../src/lib/quota";
test("external provider quota is isolated from Gemini keys and model names", () => {
  const cfg = { textProvider: "openrouter" as const, keys: ["g1", "g2"], keysSharedProject: false, limits: { flash: 20, lite: 500 } };
  assert.equal(quotaCap(cfg, "generation", "google/gemini-lite"), 20);
  assert.equal(quotaModelId(cfg, "generation", "google/gemini-lite"), "openrouter:google/gemini-lite");
  assert.equal(quotaModelId(cfg, "embedding", "gemini-embedding-2"), "gemini-embedding-2");
  assert.equal(quotaCap({ ...cfg, textProvider: "gemini" }, "generation", "gemini-lite"), 1000);
});
