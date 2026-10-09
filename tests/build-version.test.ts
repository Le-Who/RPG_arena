import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
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
    'import loaded from "./next.config.ts"; const exported=loaded.default??loaded; const config=typeof exported==="function"?await exported("phase-production-build",{}):exported; console.log(JSON.stringify({buildId:await config.generateBuildId(),publicId:config.env.NEXT_PUBLIC_CHRONICLE_BUILD_ID}));',
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

test("automatic identity survives real Next config re-evaluation in a build worker", () => {
  const output = resolve("output/test-audit"); mkdirSync(output, { recursive: true });
  const fixture = mkdtempSync(join(output, "build-version-worker-"));
  assert.ok(fixture.startsWith(output + sep));
  copyFileSync("next.config.ts", join(fixture, "next.config.ts"));
  const env = { ...process.env }; delete env.CHRONICLE_BUILD_ID; delete env.NEXT_PUBLIC_CHRONICLE_BUILD_ID;
  const load = 'const imported=(await import("next/dist/server/config.js")).default; const config=await (imported.default??imported)("phase-production-build",process.cwd(),{silent:true});';
  const projection = '{buildId:await config.generateBuildId(),publicId:config.env.NEXT_PUBLIC_CHRONICLE_BUILD_ID}';
  const child = `${load} console.log(JSON.stringify(${projection}));`;
  const parent = `${load} const {execFileSync}=await import("node:child_process"); const worker=JSON.parse(execFileSync(process.execPath,["--import","tsx","--input-type=module","-e",${JSON.stringify(child)}],{cwd:process.cwd(),env:process.env,encoding:"utf8",stdio:["ignore","pipe","pipe"]})); console.log(JSON.stringify({main:${projection},worker}));`;
  try {
    const result = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", parent], { cwd: fixture, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    assert.match(result.main.buildId, /^[A-Za-z0-9_-]{1,128}$/);
    assert.equal(result.main.publicId, result.main.buildId);
    assert.deepEqual(result.worker, result.main, "worker must compile the same automatic ID as its parent build");
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("production config takes the persisted build identity even with restart overrides", () => {
  const output = resolve("output/test-audit"); mkdirSync(output, { recursive: true });
  const fixture = mkdtempSync(join(output, "build-version-server-"));
  assert.ok(fixture.startsWith(output + sep));
  copyFileSync("next.config.ts", join(fixture, "next.config.ts"));
  mkdirSync(join(fixture, ".next")); writeFileSync(join(fixture, ".next/BUILD_ID"), "compiled-release-A\n");
  const code = 'const imported=(await import("next/dist/server/config.js")).default; const config=await (imported.default??imported)("phase-production-server",process.cwd(),{silent:true}); console.log(JSON.stringify({buildId:await config.generateBuildId(),publicId:config.env.NEXT_PUBLIC_CHRONICLE_BUILD_ID}));';
  try {
    for (const override of [undefined, "restart-release-B", "invalid/at-start"]) {
      const env = { ...process.env }; delete env.CHRONICLE_BUILD_ID; delete env.NEXT_PUBLIC_CHRONICLE_BUILD_ID;
      if (override !== undefined) env.CHRONICLE_BUILD_ID = override;
      const result = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: fixture, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
      assert.deepEqual(result, { buildId: "compiled-release-A", publicId: "compiled-release-A" });
    }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
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
