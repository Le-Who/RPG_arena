import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

function withPreloaderFixture(engines: string, pin: string, body: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "chronicle-runtime-policy-"));
  try {
    const helpers = join(directory, "tests", "helpers");
    mkdirSync(helpers, { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true, engines: { node: engines } }));
    writeFileSync(join(directory, ".node-version"), pin + "\n");
    for (const name of ["test-environment.ts", "node-runtime.ts"]) {
      copyFileSync(join(root, "tests", "helpers", name), join(helpers, name));
    }
    symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runPreloader(directory: string, body: string) {
  const allowed = new Set(["systemroot", "windir", "comspec", "path", "pathext", "temp", "tmp", "userprofile", "localappdata", "appdata", "systemdrive", "homedrive", "homepath"]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name.toLowerCase())));
  return spawnSync(process.execPath, ["--import", "tsx", "--import", "./tests/helpers/test-environment.ts", "--input-type=module", "-e", body], {
    cwd: directory,
    env: { ...env, NODE_ENV: "test", DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:2/must_not_be_used", GEMINI_API_KEY: "fixture-sentinel", CHRONICLE_SECRET_KEYS: "fixture-sentinel" },
    encoding: "utf8", timeout: 30_000, windowsHide: true,
  });
}

test("test preloader rejects an unsupported runtime before executing the test body", () => {
  withPreloaderFixture(">=99 <100", "99.0.0", directory => {
    const marker = join(directory, "body-executed");
    const result = runPreloader(directory, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');`);
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /UNSUPPORTED_TEST_NODE/);
    assert.equal(existsSync(marker), false);
  });
});

test("test preloader permits a supported runtime and sanitizes fixture credentials", () => {
  withPreloaderFixture(`>=${process.versions.node} <${Number(process.versions.node.split(".")[0]) + 1}`, process.versions.node, directory => {
    const result = runPreloader(directory, "console.log(JSON.stringify({ database: process.env.DATABASE_URL, provider: process.env.GEMINI_API_KEY ?? null, secret: process.env.CHRONICLE_SECRET_KEYS ?? null }));");
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      database: "postgresql://test:test@127.0.0.1:1/chronicle_test", provider: null, secret: null,
    });
  });
});

test("runtime policy accepts the pinned Node release and later Node 22 maintenance releases", async () => {
  const { assertTestRuntime } = await import("./helpers/node-runtime");
  for (const version of ["22.23.3", "22.23.4", "22.24.0"]) assert.doesNotThrow(() => assertTestRuntime(version));
});

test("runtime policy rejects the affected Node 24 branch", async () => {
  const { assertTestRuntime } = await import("./helpers/node-runtime");
  for (const version of ["24.13.0", "24.22.0", "24.99.0"]) {
    assert.throws(() => assertTestRuntime(version), { code: "UNSUPPORTED_TEST_NODE" });
  }
});

test("runtime policy rejects outdated, unvalidated and malformed Node versions", async () => {
  const { assertTestRuntime } = await import("./helpers/node-runtime");
  for (const version of ["20.19.0", "22.23.2", "23.0.0", "25.0.0", "26.12.0", "22.23.3-rc.1", "22", "invalid"]) {
    assert.throws(() => assertTestRuntime(version), { code: "UNSUPPORTED_TEST_NODE" });
  }
});

test("the pinned Node release satisfies the project, Next and ESLint engine contracts", () => {
  const require = createRequire(import.meta.url);
  const semver = require("semver") as { satisfies(version: string, range: string): boolean };
  const pinned = readFileSync(join(root, ".node-version"), "utf8").trim();
  for (const filename of [join(root, "package.json"), require.resolve("next/package.json"), join(dirname(require.resolve("eslint")), "..", "package.json")]) {
    const manifest = JSON.parse(readFileSync(filename, "utf8")) as { engines: { node: string } };
    assert.equal(semver.satisfies(pinned, manifest.engines.node), true, `${pinned} must satisfy ${filename}: ${manifest.engines.node}`);
  }
});
