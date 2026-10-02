import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { NextRequest } from "next/server";
import { GET as version } from "../src/app/api/version/route";
import { GET as worker } from "../src/app/sw.js/route";
import { APP_BUILD_ID } from "../src/lib/build-version";
import { proxy } from "../src/proxy";

function configBuild(override?: string) {
  const env = { ...process.env };
  delete env.CHRONICLE_BUILD_ID;
  if (override !== undefined) env.CHRONICLE_BUILD_ID = override;
  return JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    'import loaded from "./next.config.ts"; const config=loaded.default??loaded; console.log(JSON.stringify({buildId:await config.generateBuildId(),publicId:config.env.NEXT_PUBLIC_CHRONICLE_BUILD_ID}));',
  ], { cwd: process.cwd(), env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

test("each build has a unique identity shared with browser compilation; release override is validated", () => {
  const a = configBuild();
  const b = configBuild();
  assert.equal(a.buildId, a.publicId);
  assert.notEqual(a.buildId, b.buildId);
  assert.deepEqual(configBuild("release-A_01"), { buildId: "release-A_01", publicId: "release-A_01" });
  for (const bad of ["", "a/b", "a".repeat(129)]) assert.throws(() => configBuild(bad), /CHRONICLE_BUILD_ID/);
});

test("version and worker use compiled identity with no-store and no guest cookie or database access", async () => {
  const response = version();
  assert.deepEqual(await response.json(), { buildId: APP_BUILD_ID });
  assert.match(response.headers.get("cache-control")!, /no-store/);
  assert.equal(response.headers.get("set-cookie"), null);
  const script = worker();
  assert.match(script.headers.get("content-type")!, /application\/javascript/);
  assert.match(script.headers.get("cache-control")!, /no-store/);
  assert.ok((await script.text()).startsWith(`const BUILD_ID = ${JSON.stringify(APP_BUILD_ID)};`));
  for (const path of ["/api/version", "/sw.js"]) {
    const passed = await proxy(new NextRequest(`https://chronicle.test${path}`));
    assert.equal(passed.headers.get("x-middleware-next"), "1");
    assert.equal(passed.headers.get("set-cookie"), null);
  }
});
