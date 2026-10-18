import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { ESLint } from "eslint";
import ts from "typescript";

const eslint = new ESLint();
const filePath = "src/app/eslint-policy-probe/page.tsx";

test("lint dependencies support ESLint without peer exceptions or compatibility bridges", () => {
  const require = createRequire(import.meta.url);
  const { satisfies } = require("semver") as { satisfies(version: string, range: string): boolean };
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
    packages: Record<string, {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    }>;
  };
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(manifest.overrides?.eslint, undefined, "ESLint peers must work without an override");
  for (const name of ["@eslint/compat", "eslint-config-next", "eslint-plugin-react", "eslint-plugin-import", "eslint-plugin-jsx-a11y"]) {
    assert.ok(!Object.keys(lock.packages).some(location => location.endsWith(`/node_modules/${name}`) || location === `node_modules/${name}`), `${name} remains in the dependency graph`);
  }
  let checkedPeers = 0;
  let checkedBracesConsumers = 0;
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (location) {
      const range = entry.dependencies?.braces ?? entry.optionalDependencies?.braces;
      if (range) {
        assert.ok(satisfies("3.0.3", range), `${location} requires a different braces API: ${range}`);
        checkedBracesConsumers++;
      }
    }
    if (!entry.peerDependencies?.eslint) continue;
    assert.ok(satisfies(ESLint.version, entry.peerDependencies.eslint), `${location} does not support ESLint ${ESLint.version}: ${entry.peerDependencies.eslint}`);
    const manifestPath = path.resolve(location, "package.json");
    if (!existsSync(manifestPath)) continue;
    const peerPath = createRequire(manifestPath).resolve("eslint/package.json");
    assert.equal(JSON.parse(readFileSync(peerPath, "utf8")).version, ESLint.version, `${location} resolved an older ESLint`);
    checkedPeers++;
  }
  assert.ok(checkedPeers > 0, "No installed ESLint peer contracts were checked");
  assert.ok(checkedBracesConsumers > 0, "No braces consumer contracts were checked");
});

const fixtures: { rule: string; severity: 1 | 2; invalid: string; valid: string }[] = [
  { rule: "@eslint-react/no-missing-component-display-name", severity: 2,
    invalid: 'import { memo } from "react"; const View = memo(() => <div />); export default View;',
    valid: 'import { memo } from "react"; const View = memo(function View() { return <div />; }); export default View;' },
  { rule: "no-restricted-syntax", severity: 2,
    invalid: 'import { Component as Base } from "react"; export default class View extends Base { render() { return <div />; } }',
    valid: "export default function View() { return <div />; }" },
  { rule: "@eslint-react/no-missing-key", severity: 2,
    invalid: "export default function View() { return [1].map(value => <div>{value}</div>); }",
    valid: "export default function View() { return [1].map(value => <div key={value}>{value}</div>); }" },
  { rule: "@eslint-react/jsx-no-comment-textnodes", severity: 2,
    invalid: "export default function View() { return <div>// comment</div>; }",
    valid: "export default function View() { return <div>{/* comment */}</div>; }" },
  { rule: "@eslint-react/jsx-no-children-prop", severity: 2,
    invalid: 'export default function View() { return <div children="Scene" />; }',
    valid: "export default function View() { return <div>Scene</div>; }" },
  { rule: "@eslint-react/jsx-no-children-prop-with-children", severity: 2,
    invalid: 'export default function View() { return <div children="Scene">Other</div>; }',
    valid: "export default function View() { return <div>Scene</div>; }" },
  { rule: "@eslint-react/dom-no-dangerously-set-innerhtml-with-children", severity: 2,
    invalid: 'export default function View() { return <div dangerouslySetInnerHTML={{ __html: "Scene" }}>Other</div>; }',
    valid: "export default function View() { return <div>Scene</div>; }" },
  { rule: "jsx-a11y-x/alt-text", severity: 1,
    invalid: 'import Image from "next/image"; export default function View() { return <Image src="/scene.png" />; }',
    valid: 'import Image from "next/image"; export default function View() { return <Image src="/scene.png" alt="Scene" />; }' },
  { rule: "jsx-a11y-x/aria-props", severity: 1,
    invalid: 'export default function View() { return <div aria-madeup="x" />; }',
    valid: 'export default function View() { return <div aria-label="Scene" />; }' },
  { rule: "jsx-a11y-x/aria-proptypes", severity: 1,
    invalid: 'export default function View() { return <div aria-hidden="maybe" />; }',
    valid: "export default function View() { return <div aria-hidden={true} />; }" },
  { rule: "jsx-a11y-x/aria-unsupported-elements", severity: 1,
    invalid: 'export default function View() { return <meta aria-label="Scene" />; }',
    valid: 'export default function View() { return <span aria-label="Scene" />; }' },
  { rule: "jsx-a11y-x/role-has-required-aria-props", severity: 1,
    invalid: 'export default function View() { return <div role="checkbox" />; }',
    valid: 'export default function View() { return <div role="checkbox" aria-checked={false} />; }' },
  { rule: "jsx-a11y-x/role-supports-aria-props", severity: 1,
    invalid: 'export default function View() { return <div role="button" aria-checked={false} />; }',
    valid: 'export default function View() { return <div role="checkbox" aria-checked={false} />; }' },
  { rule: "react-hooks/rules-of-hooks", severity: 2,
    invalid: 'import { useState } from "react"; export default function View({ show }) { if (show) { useState(0); } return null; }',
    valid: 'import { useState } from "react"; export default function View() { const [value] = useState(0); return <div>{value}</div>; }' },
  { rule: "react-hooks/exhaustive-deps", severity: 1,
    invalid: 'import { useEffect } from "react"; export default function View({ value }) { useEffect(() => { console.log(value); }, []); return null; }',
    valid: 'import { useEffect } from "react"; export default function View({ value }) { useEffect(() => { console.log(value); }, [value]); return null; }' },
  { rule: "import-x/no-anonymous-default-export", severity: 2,
    invalid: 'import { memo } from "react"; export default memo(() => <div />);',
    valid: 'import { memo } from "react"; const View = memo(function View() { return <div />; }); export default View;' },
  { rule: "@next/next/no-sync-scripts", severity: 2,
    invalid: 'export default function View() { return <script src="/client.js" />; }',
    valid: 'export default function View() { return <script async src="/client.js" />; }' },
];

for (const fixture of fixtures) {
  test(`TSX retains ${fixture.rule} diagnostics and accepts the correction`, async () => {
    const [invalid] = await eslint.lintText(fixture.invalid, { filePath });
    assert.equal(invalid.fatalErrorCount, 0, JSON.stringify(invalid.messages));
    const messages = invalid.messages.filter(message => message.ruleId === fixture.rule);
    assert.ok(messages.length > 0, JSON.stringify(invalid.messages));
    assert.ok(messages.every(message => message.severity === fixture.severity));
    const [valid] = await eslint.lintText(fixture.valid, { filePath });
    assert.equal(valid.fatalErrorCount, 0, JSON.stringify(valid.messages));
    assert.deepEqual(valid.messages, []);
  });
}

for (const extension of ["js", "jsx", "mjs", "cjs"]) {
  test(`JSX in .${extension} cannot bypass the required TypeScript checks`, async () => {
    for (const source of ["const view = <div />;", "const view = <>Scene</>;"]) {
      const [result] = await eslint.lintText(source, { filePath: `src/eslint-policy-probe.${extension}` });
      assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
      assert.ok(result.messages.some(message => message.ruleId === "no-restricted-syntax" && message.severity === 2), JSON.stringify(result.messages));
    }
    const [valid] = await eslint.lintText("const scene = 'Scene';", { filePath: `src/eslint-policy-probe.${extension}` });
    assert.equal(valid.fatalErrorCount, 0, JSON.stringify(valid.messages));
    assert.deepEqual(valid.messages, []);
  });
}

test("TSX class aliases and error boundaries cannot bypass the function component policy", async () => {
  for (const source of [
    'import React from "react"; export default class View extends React.Component { render() { return <div />; } }',
    'import { PureComponent as Base } from "react"; export default class View extends Base { render() { return <div />; } }',
    'import React from "react"; const Base = React.Component; export default class View extends Base { render() { return <div />; } }',
    'import React from "react"; export default class View extends React.Component { componentDidCatch() {} render() { return <div />; } }',
    'const View = class { render() { return <div />; } }; export default View;',
  ]) {
    const [result] = await eslint.lintText(source, { filePath });
    assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
    assert.ok(result.messages.some(message => message.ruleId === "no-restricted-syntax" && message.severity === 2), JSON.stringify(result.messages));
  }
  const [valid] = await eslint.lintText('export class ServiceError extends Error {}', { filePath: "src/eslint-policy-probe.ts" });
  assert.deepEqual(valid.messages, []);
});

test("TypeScript assertions cannot hide an anonymous default component export", async () => {
  for (const assertion of ["as unknown", "satisfies unknown", "!"]) {
    const [invalid] = await eslint.lintText(`import { memo } from "react"; export default (memo(() => <div />) ${assertion});`, { filePath });
    assert.equal(invalid.fatalErrorCount, 0, JSON.stringify(invalid.messages));
    assert.ok(invalid.messages.some(message => message.ruleId === "no-restricted-syntax" && message.severity === 2), JSON.stringify(invalid.messages));
    const [valid] = await eslint.lintText(`import { memo } from "react"; const View = memo(function View() { return <div />; }) ${assertion}; export default View;`, { filePath });
    assert.deepEqual(valid.messages, []);
  }
});

test("the project compiler rejects duplicate JSX props, undefined JSX names and removed React APIs", () => {
  const configuration = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
  assert.equal(configuration.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(configuration.config, ts.sys, process.cwd());
  assert.deepEqual(parsed.errors, []);
  const probes = [
    { name: "missing", code: 2304, source: "export default function View() { return <Missing />; }" },
    { name: "duplicate", code: 17001, source: 'export default function View() { return <div title="a" title="b" />; }' },
    { name: "string-ref", code: 2322, source: 'export default function View() { return <div ref="legacy" />; }' },
    { name: "legacy-dom", code: 2305, count: 4, source: 'import { render, hydrate, findDOMNode, unmountComponentAtNode } from "react-dom"; export { render, hydrate, findDOMNode, unmountComponentAtNode };' },
    { name: "legacy-react", code: 2339, count: 2, source: 'import React from "react"; React.createClass({}); React.PropTypes;' },
    { name: "valid", code: null, source: 'function Present() { return null; } export default function View() { return <div title="Scene"><Present /></div>; }' },
  ].map(probe => ({ ...probe, filename: path.resolve(`src/eslint-compiler-${probe.name}.tsx`) }));
  const options = { ...parsed.options, incremental: false, noEmit: true };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (filename, languageVersion, onError, shouldCreateNewSourceFile) => {
    const probe = probes.find(candidate => candidate.filename === path.resolve(filename));
    return probe ? ts.createSourceFile(filename, probe.source, languageVersion, true, ts.ScriptKind.TSX)
      : getSourceFile(filename, languageVersion, onError, shouldCreateNewSourceFile);
  };
  const program = ts.createProgram(probes.map(probe => probe.filename), options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  for (const probe of probes) {
    const messages = diagnostics.filter(message => message.file && path.resolve(message.file.fileName) === probe.filename);
    if (probe.code === null) assert.deepEqual(messages, []);
    else assert.equal(messages.filter(message => message.code === probe.code).length, probe.count ?? 1, `${probe.name}: ${messages.map(message => ts.flattenDiagnosticMessageText(message.messageText, " ")).join("; ")}`);
  }
});

test("all shipped JSX stays in TypeScript files included in the project typecheck", async () => {
  const configuration = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
  assert.equal(configuration.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(configuration.config, ts.sys, process.cwd());
  assert.deepEqual(parsed.errors, []);
  const included = new Set(parsed.fileNames.map(filename => path.resolve(filename)));
  const files = ts.sys.readDirectory("src", [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"], ["**/node_modules/**"]);
  let checked = 0;
  for (const filename of files) {
    const source = ts.sys.readFile(filename)!;
    const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
    let hasJsx = false;
    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) hasJsx = true;
      ts.forEachChild(node, visit);
    };
    visit(ast);
    if (!hasJsx) continue;
    assert.equal(path.extname(filename), ".tsx", filename);
    assert.ok(included.has(path.resolve(filename)), `${filename} is outside the typecheck`);
    assert.ok(!/@ts-(?:nocheck|ignore|expect-error)\b/.test(source), `${filename} suppresses compiler diagnostics`);
    assert.equal(await eslint.isPathIgnored(filename), false, `${filename} is outside lint`);
    checked++;
  }
  assert.ok(checked > 0, "No shipped JSX was checked");
});

test("JSX quotes and apostrophes are valid text while malformed JSX remains rejected", async () => {
  const [result] = await eslint.lintText('export default function View() { return <div>"История" author\'s</div>; }', { filePath });
  assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
  assert.deepEqual(result.messages, []);
  for (const text of [">", "}"]) {
    const [invalid] = await eslint.lintText(`export default function View() { return <div>${text}</div>; }`, { filePath });
    assert.equal(invalid.fatalErrorCount, 1, JSON.stringify(invalid.messages));
  }
});

test("leading inline disable comments still suppress the configured hook rule", async () => {
  const [result] = await eslint.lintText('/* eslint-disable react-hooks/rules-of-hooks -- external fixture */\nimport { useState } from "react"; export default function View({ show }) { if (show) { useState(0); } return null; }', { filePath });
  assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
  assert.deepEqual(result.messages, []);
  assert.equal(result.suppressedMessages.filter(message => message.ruleId === "react-hooks/rules-of-hooks").length, 1);
});

test("non-TSX anonymous export warnings retain their previous defaults", async () => {
  const [invalid] = await eslint.lintText("export default { label: 'Scene' };", { filePath: "src/eslint-policy-probe.mjs" });
  assert.equal(invalid.fatalErrorCount, 0, JSON.stringify(invalid.messages));
  assert.equal(invalid.messages.filter(message => message.ruleId === "import-x/no-anonymous-default-export" && message.severity === 1).length, 1);
  const [valid] = await eslint.lintText("export default factory();", { filePath: "src/eslint-policy-probe.mjs" });
  assert.deepEqual(valid.messages, []);
});

test("native import ordering fixes preserve comments", async () => {
  const configured = new ESLint({ fix: true, overrideConfig: [{ rules: {
    "import-x/order": ["error", { "newlines-between": "always" }],
  } }] });
  const [result] = await configured.lintText('import local from "./local"; // keep\nimport fs from "node:fs";\nexport { fs, local };\n', { filePath: "src/eslint-policy-probe.mjs" });
  assert.equal(result.output, 'import fs from "node:fs";\n\nimport local from "./local"; // keep\nexport { fs, local };\n');
  assert.deepEqual(result.messages, []);
});
