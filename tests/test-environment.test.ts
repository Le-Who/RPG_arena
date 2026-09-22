import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("unit-test bootstrap overrides inherited database and removes real-provider configuration", async () => {
  const variables = ["GEMINI_API_KEY", "GEMINI_API_KEYS", "OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "NARRATIVE_ADMIN_OPENROUTER_API_KEY", "NARRATIVE_ADMIN_TYPESAFE_API_KEY", "CHRONICLE_SECRET_KEYS", "CHRONICLE_SECRET_ACTIVE_KEY", "CHRONICLE_ALLOW_LEGACY_PLAINTEXT", "CHRONICLE_ADMIN_ACCOUNT_IDS"];
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--import", "tsx", "--import", "./tests/helpers/test-environment.ts", "--input-type=module", "--eval",
    `console.log(JSON.stringify({ database:process.env.DATABASE_URL, present:${JSON.stringify(variables)}.filter(k=>process.env[k]!==undefined) }))`,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: "postgresql://synthetic:synthetic@invalid.example/never_connect", ...Object.fromEntries(variables.map(name => [name, "synthetic-inherited-value"])) },
  });
  assert.deepEqual(JSON.parse(stdout), { database: "postgresql://test:test@127.0.0.1:1/chronicle_test", present: [] });
});
