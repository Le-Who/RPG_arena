import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { ESLint } from "eslint";

const require = createRequire(import.meta.url);
const helperPath = path.join(
  path.dirname(require.resolve("@next/eslint-plugin-next")),
  "utils/get-root-dirs.js",
);
const { getRootDirs } = require(helperPath) as {
  getRootDirs(context: { cwd: string; settings: { next?: { rootDir?: unknown } } }): string[];
};
const fixture = mkdtempSync(path.join(tmpdir(), "chronicle lint glob-"));
after(() => rmSync(fixture, { recursive: true, force: true }));
for (const directory of ["alpha", "beta", ".hidden"]) {
  const pages = path.join(fixture, "packages", directory, "pages");
  mkdirSync(pages, { recursive: true });
  writeFileSync(path.join(pages, "index.tsx"), "export default function Page() { return null; }\n");
  writeFileSync(path.join(pages, "about.tsx"), "export default function About() { return null; }\n");
}
writeFileSync(path.join(fixture, "packages", "file.ts"), "export {};\n");
for (const directory of ["01", "02", "03", "1", "2", "3"]) {
  mkdirSync(path.join(fixture, "ranges", directory), { recursive: true });
}
mkdirSync(path.join(fixture, "links", "alpha"), { recursive: true });
mkdirSync(path.join(fixture, "outside"), { recursive: true });
symlinkSync(path.join(fixture, "links", "alpha"), path.join(fixture, "links", "alias"), process.platform === "win32" ? "junction" : "dir");
symlinkSync(path.join(fixture, "outside"), path.join(fixture, "links", "external"), process.platform === "win32" ? "junction" : "dir");
const posix = (value: string) => value.replace(/\\/g, "/");
const packages = posix(path.join(fixture, "packages"));
const ranges = posix(path.join(fixture, "ranges"));
const links = posix(path.join(fixture, "links"));
const roots = (rootDir: unknown) => getRootDirs({ cwd: fixture, settings: { next: { rootDir } } }).sort();

test("Next keeps the working directory when no root setting is supplied", () => {
  assert.deepEqual(getRootDirs({ cwd: fixture, settings: {} }), [fixture]);
});

for (const [name, pattern, expected] of [
  ["literal root without descendants", `${packages}/alpha`, [`${packages}/alpha`]],
  ["trailing slash", `${packages}/alpha/`, [`${packages}/alpha/`]],
  ["Windows separators", `${packages}/alpha`.replace(/\//g, "\\"), [`${packages}/alpha`]],
  ["wildcard excludes files and hidden roots", `${packages}/*`, [`${packages}/alpha`, `${packages}/beta`]],
  ["brace alternatives", `${packages}/{alpha,beta}`, [`${packages}/alpha`, `${packages}/beta`]],
  ["extglob alternatives", `${packages}/@(alpha|beta)`, [`${packages}/alpha`, `${packages}/beta`]],
  ["nested root pattern", `${packages}/*/pages`, [`${packages}/alpha/pages`, `${packages}/beta/pages`]],
  ["explicit hidden root", `${packages}/.hidden`, [`${packages}/.hidden`]],
  ["missing root", `${packages}/missing`, []],
  ["file is not a root directory", `${packages}/file.ts`, []],
  ["padded numeric brace ranges", `${ranges}/{01..03}`, [`${ranges}/01`, `${ranges}/02`, `${ranges}/03`]],
  ["stepped numeric brace ranges", `${ranges}/{1..3..2}`, [`${ranges}/1`, `${ranges}/3`]],
  ["literal directory links", `${links}/alias`, [`${links}/alias`]],
  ["links to targets outside the search base", `${links}/external`, [`${links}/external`]],
  ["directory links in wildcard results", `${links}/*`, [`${links}/alpha`, `${links}/alias`, `${links}/external`]],
  ["terminal globstar excludes its base", `${packages}/**`, [`${packages}/alpha`, `${packages}/alpha/pages`, `${packages}/beta`, `${packages}/beta/pages`]],
] as const) {
  test(`Next root discovery preserves ${name}`, () => {
    assert.deepEqual(roots(pattern), [...expected].sort());
  });
}

test("Next root arrays combine roots and ignore non-string entries", () => {
  assert.deepEqual(roots([`${packages}/alpha`, 42, `${packages}/beta`]), [
    `${packages}/alpha`, `${packages}/beta`,
  ]);
});

test("Next resolves relative root paths from the lint working directory", () => {
  const child = spawnSync(process.execPath, ["-e", `
    const { getRootDirs } = require(process.argv[1]);
    process.stdout.write(JSON.stringify(getRootDirs({
      cwd: process.cwd(), settings: { next: { rootDir: 'packages/alpha' } }
    })));
  `, helperPath], { cwd: fixture, encoding: "utf8", timeout: 5_000, windowsHide: true });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), ["packages/alpha"]);
});

test("deeply nested brace roots cannot overflow the Next glob parser stack", () => {
  const child = spawnSync(process.execPath, ["-e", `
    const { getRootDirs } = require(process.argv[1]);
    const rootDir = process.argv[2] + '/' + '{'.repeat(4500) + 'alpha,beta' + '}'.repeat(4500);
    try {
      getRootDirs({ cwd: process.cwd(), settings: { next: { rootDir } } });
      process.stdout.write(JSON.stringify({ rejected: false }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ name: error.name, code: error.code }));
    }
  `, helperPath, packages], {
    cwd: fixture, encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { name: "SyntaxError", code: "ERR_BRACES_DEPTH" });
});

test("the real Next rule still reports internal HTML links with an explicit root", async () => {
  const eslint = new ESLint({
    overrideConfig: [{ settings: { next: { rootDir: `${packages}/alpha` } } }],
  });
  const options = { filePath: "src/app/eslint-glob-probe/page.tsx" };
  const [invalid] = await eslint.lintText(
    'export default function Page() { return <a href="/about">About</a>; }', options,
  );
  assert.equal(invalid.messages.filter((message) => message.ruleId === "@next/next/no-html-link-for-pages").length, 1);
  const [valid] = await eslint.lintText(
    'import Link from "next/link"; export default function Page() { return <Link href="/about">About</Link>; }', options,
  );
  assert.deepEqual(valid.messages, []);
});
