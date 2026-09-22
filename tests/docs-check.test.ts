import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { checkDocumentation } from "../scripts/lib/check-docs";

async function fixture(files: Record<string, string>, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "chronicle-docs-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      const file = join(root, name);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text);
    }
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("documentation checks existing relative links without fetching external URLs or checking anchors", async () => {
  await fixture({
    "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
    "README.md": "[guide](docs/My%20Guide.md#intro) [remote](https://invalid.example/x) [mail](mailto:a@example.com) [top](#top)\n`npm run test`",
    "docs/My Guide.md": "[home](../README.md)\n```md\n[example](does-not-exist.md)\n```",
    "revisions/other/README.md": "[not our document](bad.md)",
  }, async root => {
    const result = await checkDocumentation(root);
    assert.deepEqual(result.errors, []);
    assert.equal(result.filesChecked, 2);
    assert.equal(result.linksChecked, 2);
  });
});

test("broken links and missing operational npm scripts identify the source document", async () => {
  await fixture({
    "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
    "README.md": "[missing](docs/missing.md)\n```sh\nnpm run absent\n```",
    "docs/worker-operations.md": "Run `npm run worker`.\n[bad encoding](bad%XY.md)",
    "docs/superpowers/plans/old.md": "Historical command `npm run retired`.",
  }, async root => {
    const result = await checkDocumentation(root);
    assert.equal(result.errors.length, 4);
    assert.ok(result.errors.some(error => error.includes("README.md") && error.includes("docs/missing.md")));
    assert.ok(result.errors.some(error => error.includes("README.md") && error.includes("absent")));
    assert.ok(result.errors.some(error => error.includes("worker-operations.md") && error.includes("worker")));
    assert.ok(result.errors.some(error => error.includes("bad%XY.md")));
    assert.ok(result.errors.every(error => !error.includes("retired")));
  });
});

test("migration documentation check rejects duplicate tags, missing SQL and non-increasing journal timestamps", async () => {
  await fixture({
    "package.json": "{}", "README.md": "Ready.",
    "drizzle/0000_init.sql": "select 1;",
    "drizzle/meta/_journal.json": JSON.stringify({ entries: [
      { idx: 0, tag: "0000_init", when: 100 },
      { idx: 1, tag: "0000_init", when: 100 },
      { idx: 2, tag: "0002_missing", when: 200 },
    ] }),
  }, async root => {
    const result = await checkDocumentation(root);
    assert.ok(result.errors.some(error => error.includes("Duplicate migration tag")));
    assert.ok(result.errors.some(error => error.includes("timestamp")));
    assert.ok(result.errors.some(error => error.includes("0002_missing.sql")));
  });
});

test("valid ledger, angle-bracket links and images are checked with no dependency on working directory", async () => {
  await fixture({
    "package.json": JSON.stringify({ scripts: { "build:deploy": "build" } }),
    "README.md": "[guide](<docs/a guide.md>) ![image](public/cover.svg) `npm run build:deploy`",
    "docs/a guide.md": "Text.", "public/cover.svg": "<svg />",
    "drizzle/0000_init.sql": "select 1;",
    "drizzle/meta/_journal.json": JSON.stringify({ entries: [{ idx: 0, tag: "0000_init", when: 100 }] }),
  }, async root => {
    const result = await checkDocumentation(root);
    assert.deepEqual(result.errors, []);
    assert.equal(result.linksChecked, 2);
  });
});
